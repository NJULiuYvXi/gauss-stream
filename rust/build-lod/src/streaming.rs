use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rayon::prelude::*;
use spark_lib::bhatt_lod;
use spark_lib::chunk_tree;
use spark_lib::decoder::{
    ChunkReceiver, MultiDecoder, SetSplatEncoding, SplatGetter, SplatInit, SplatProps,
    SplatReceiver,
};
use spark_lib::gsplat::GsplatArray;
use spark_lib::rad::{
    RadAlphaEncoding, RadCenterEncoding, RadEncoder, RadOrientationEncoding, RadRgbEncoding,
    RadScalesEncoding, RadShEncoding,
};
use spark_lib::tsplat::TsplatArray;

const INPUT_CHUNK_BYTES: usize = 1024 * 1024;
const PROPERTY_BATCH: usize = 65_536;
const LOAD_BATCH: usize = 32_768;
const MAX_GRID_DIM: usize = 8;
const BYTES_PER_SPLAT_BUDGET: usize = 4096;
const MAX_TILE_SPLATS: usize = 750_000;
const MIN_TILE_SPLATS: usize = 25_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StreamingQuality {
    Compact,
    High,
    #[default]
    Original,
}

impl StreamingQuality {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "compact" => Some(Self::Compact),
            "high" => Some(Self::High),
            "original" => Some(Self::Original),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::High => "high",
            Self::Original => "original",
        }
    }

    fn precision_description(self) -> &'static str {
        match self {
            Self::Compact => "adaptive-r8-f16",
            Self::High => "f16-properties",
            Self::Original => "source-f32-preserved",
        }
    }
}

fn configure_rad_encoder<T: SplatGetter>(getter: T, quality: StreamingQuality) -> RadEncoder<T> {
    let mut encoder = RadEncoder::new(getter);
    match quality {
        StreamingQuality::Compact => {}
        StreamingQuality::High => {
            encoder = encoder
                .with_center_encoding(RadCenterEncoding::F32LeBytes)
                .with_alpha_encoding(RadAlphaEncoding::F16)
                .with_rgb_encoding(RadRgbEncoding::F16)
                .with_scales_encoding(RadScalesEncoding::LnF16)
                .with_orientation_encoding(RadOrientationEncoding::F16)
                .with_sh_encoding(RadShEncoding::F16);
        }
        StreamingQuality::Original => {
            // Byte-plane encoding and Deflate are reversible. Every source
            // leaf attribute remains float32; only generated LoD parents are new.
            encoder = encoder
                .with_center_encoding(RadCenterEncoding::F32LeBytes)
                .with_alpha_encoding(RadAlphaEncoding::F32)
                .with_rgb_encoding(RadRgbEncoding::F32)
                .with_scales_encoding(RadScalesEncoding::F32)
                .with_orientation_encoding(RadOrientationEncoding::F32)
                .with_sh_encoding(RadShEncoding::F32);
        }
    }
    encoder.resolve_encoding();
    encoder
}

struct PropertyFile {
    file: File,
    components: usize,
}

impl PropertyFile {
    fn create(dir: &Path, name: &str, components: usize, count: usize) -> Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(dir.join(format!("{name}.f32")))?;
        file.set_len((count * components * size_of::<f32>()) as u64)?;
        Ok(Self { file, components })
    }

    fn open(dir: &Path, name: &str, components: usize) -> Result<Self> {
        Ok(Self {
            file: OpenOptions::new()
                .read(true)
                .write(false)
                .open(dir.join(format!("{name}.f32")))?,
            components,
        })
    }

    fn write(&mut self, base: usize, count: usize, values: &[f32]) -> Result<()> {
        let len = count * self.components;
        anyhow::ensure!(values.len() >= len, "property batch is too small");
        self.file.seek(SeekFrom::Start(
            (base * self.components * size_of::<f32>()) as u64,
        ))?;
        let mut bytes = vec![0u8; len * size_of::<f32>()];
        for (chunk, value) in bytes.chunks_exact_mut(4).zip(&values[..len]) {
            chunk.copy_from_slice(&value.to_le_bytes());
        }
        self.file.write_all(&bytes)?;
        Ok(())
    }

    fn read(&mut self, base: usize, count: usize, output: &mut Vec<f32>) -> Result<()> {
        let len = count * self.components;
        output.resize(len, 0.0);
        self.file.seek(SeekFrom::Start(
            (base * self.components * size_of::<f32>()) as u64,
        ))?;
        let mut bytes = vec![0u8; len * size_of::<f32>()];
        self.file.read_exact(&mut bytes)?;
        for (value, chunk) in output.iter_mut().zip(bytes.chunks_exact(4)) {
            *value = f32::from_le_bytes(chunk.try_into().unwrap());
        }
        Ok(())
    }
}

pub struct DiskStageReceiver {
    dir: PathBuf,
    num_splats: usize,
    max_sh_degree: usize,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
    center: Option<PropertyFile>,
    opacity: Option<PropertyFile>,
    rgb: Option<PropertyFile>,
    scale: Option<PropertyFile>,
    quat: Option<PropertyFile>,
    sh1: Option<PropertyFile>,
    sh2: Option<PropertyFile>,
    sh3: Option<PropertyFile>,
}

impl DiskStageReceiver {
    fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            num_splats: 0,
            max_sh_degree: 0,
            bounds_min: [f32::INFINITY; 3],
            bounds_max: [f32::NEG_INFINITY; 3],
            center: None,
            opacity: None,
            rgb: None,
            scale: None,
            quat: None,
            sh1: None,
            sh2: None,
            sh3: None,
        }
    }

    fn update_bounds(&mut self, count: usize, centers: &[f32]) {
        for point in centers.chunks_exact(3).take(count) {
            for (axis, value) in point.iter().copied().enumerate() {
                if value.is_finite() {
                    self.bounds_min[axis] = self.bounds_min[axis].min(value);
                    self.bounds_max[axis] = self.bounds_max[axis].max(value);
                }
            }
        }
    }

    fn flush(&mut self) -> Result<()> {
        for property in [
            &mut self.center,
            &mut self.opacity,
            &mut self.rgb,
            &mut self.scale,
            &mut self.quat,
            &mut self.sh1,
            &mut self.sh2,
            &mut self.sh3,
        ] {
            if let Some(property) = property {
                property.file.flush()?;
            }
        }
        Ok(())
    }
}

impl SplatReceiver for DiskStageReceiver {
    fn init_splats(&mut self, init: &SplatInit) -> Result<()> {
        anyhow::ensure!(
            !init.lod_tree,
            "streaming input must not already contain an LOD tree"
        );
        self.num_splats = init.num_splats;
        self.max_sh_degree = init.max_sh_degree.min(3);
        fs::create_dir_all(&self.dir)?;
        self.center = Some(PropertyFile::create(
            &self.dir,
            "center",
            3,
            init.num_splats,
        )?);
        self.opacity = Some(PropertyFile::create(
            &self.dir,
            "opacity",
            1,
            init.num_splats,
        )?);
        self.rgb = Some(PropertyFile::create(&self.dir, "rgb", 3, init.num_splats)?);
        self.scale = Some(PropertyFile::create(
            &self.dir,
            "scale",
            3,
            init.num_splats,
        )?);
        self.quat = Some(PropertyFile::create(&self.dir, "quat", 4, init.num_splats)?);
        if self.max_sh_degree >= 1 {
            self.sh1 = Some(PropertyFile::create(&self.dir, "sh1", 9, init.num_splats)?);
        }
        if self.max_sh_degree >= 2 {
            self.sh2 = Some(PropertyFile::create(&self.dir, "sh2", 15, init.num_splats)?);
        }
        if self.max_sh_degree >= 3 {
            self.sh3 = Some(PropertyFile::create(&self.dir, "sh3", 21, init.num_splats)?);
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        self.flush()
    }

    fn set_encoding(&mut self, _encoding: &SetSplatEncoding) -> Result<()> {
        Ok(())
    }

    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps) {
        self.set_center(base, count, batch.center);
        self.set_opacity(base, count, batch.opacity);
        self.set_rgb(base, count, batch.rgb);
        self.set_scale(base, count, batch.scale);
        self.set_quat(base, count, batch.quat);
        self.set_sh(base, count, batch.sh1, batch.sh2, batch.sh3);
    }

    fn set_center(&mut self, base: usize, count: usize, values: &[f32]) {
        self.update_bounds(count, values);
        self.center
            .as_mut()
            .unwrap()
            .write(base, count, values)
            .unwrap();
    }

    fn set_opacity(&mut self, base: usize, count: usize, values: &[f32]) {
        self.opacity
            .as_mut()
            .unwrap()
            .write(base, count, values)
            .unwrap();
    }

    fn set_rgb(&mut self, base: usize, count: usize, values: &[f32]) {
        self.rgb
            .as_mut()
            .unwrap()
            .write(base, count, values)
            .unwrap();
    }

    fn set_rgba(&mut self, _base: usize, _count: usize, _values: &[f32]) {
        panic!("RGBA-only streaming input is not supported");
    }

    fn set_scale(&mut self, base: usize, count: usize, values: &[f32]) {
        self.scale
            .as_mut()
            .unwrap()
            .write(base, count, values)
            .unwrap();
    }

    fn set_quat(&mut self, base: usize, count: usize, values: &[f32]) {
        self.quat
            .as_mut()
            .unwrap()
            .write(base, count, values)
            .unwrap();
    }

    fn set_sh(&mut self, base: usize, count: usize, sh1: &[f32], sh2: &[f32], sh3: &[f32]) {
        if !sh1.is_empty() {
            self.set_sh1(base, count, sh1);
        }
        if !sh2.is_empty() {
            self.set_sh2(base, count, sh2);
        }
        if !sh3.is_empty() {
            self.set_sh3(base, count, sh3);
        }
    }

    fn set_sh1(&mut self, base: usize, count: usize, values: &[f32]) {
        if let Some(property) = &mut self.sh1 {
            property.write(base, count, values).unwrap();
        }
    }

    fn set_sh2(&mut self, base: usize, count: usize, values: &[f32]) {
        if let Some(property) = &mut self.sh2 {
            property.write(base, count, values).unwrap();
        }
    }

    fn set_sh3(&mut self, base: usize, count: usize, values: &[f32]) {
        if let Some(property) = &mut self.sh3 {
            property.write(base, count, values).unwrap();
        }
    }
}

struct StageReader {
    num_splats: usize,
    max_sh_degree: usize,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
    center: PropertyFile,
    opacity: PropertyFile,
    rgb: PropertyFile,
    scale: PropertyFile,
    quat: PropertyFile,
    sh1: Option<PropertyFile>,
    sh2: Option<PropertyFile>,
    sh3: Option<PropertyFile>,
}

impl StageReader {
    fn open(stage: &DiskStageReceiver) -> Result<Self> {
        Ok(Self {
            num_splats: stage.num_splats,
            max_sh_degree: stage.max_sh_degree,
            bounds_min: stage.bounds_min,
            bounds_max: stage.bounds_max,
            center: PropertyFile::open(&stage.dir, "center", 3)?,
            opacity: PropertyFile::open(&stage.dir, "opacity", 1)?,
            rgb: PropertyFile::open(&stage.dir, "rgb", 3)?,
            scale: PropertyFile::open(&stage.dir, "scale", 3)?,
            quat: PropertyFile::open(&stage.dir, "quat", 4)?,
            sh1: (stage.max_sh_degree >= 1)
                .then(|| PropertyFile::open(&stage.dir, "sh1", 9))
                .transpose()?,
            sh2: (stage.max_sh_degree >= 2)
                .then(|| PropertyFile::open(&stage.dir, "sh2", 15))
                .transpose()?,
            sh3: (stage.max_sh_degree >= 3)
                .then(|| PropertyFile::open(&stage.dir, "sh3", 21))
                .transpose()?,
        })
    }
}

#[derive(Default)]
struct Batch {
    center: Vec<f32>,
    opacity: Vec<f32>,
    rgb: Vec<f32>,
    scale: Vec<f32>,
    quat: Vec<f32>,
    sh1: Vec<f32>,
    sh2: Vec<f32>,
    sh3: Vec<f32>,
}

impl Batch {
    fn read(stage: &mut StageReader, base: usize, count: usize) -> Result<Self> {
        let mut batch = Self::default();
        stage.center.read(base, count, &mut batch.center)?;
        stage.opacity.read(base, count, &mut batch.opacity)?;
        stage.rgb.read(base, count, &mut batch.rgb)?;
        stage.scale.read(base, count, &mut batch.scale)?;
        stage.quat.read(base, count, &mut batch.quat)?;
        if let Some(property) = &mut stage.sh1 {
            property.read(base, count, &mut batch.sh1)?;
        }
        if let Some(property) = &mut stage.sh2 {
            property.read(base, count, &mut batch.sh2)?;
        }
        if let Some(property) = &mut stage.sh3 {
            property.read(base, count, &mut batch.sh3)?;
        }
        Ok(batch)
    }
}

fn record_float_count(max_sh_degree: usize) -> usize {
    14 + if max_sh_degree >= 1 { 9 } else { 0 }
        + if max_sh_degree >= 2 { 15 } else { 0 }
        + if max_sh_degree >= 3 { 21 } else { 0 }
}

fn push_float(output: &mut Vec<u8>, value: f32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn append_record(output: &mut Vec<u8>, batch: &Batch, index: usize, max_sh_degree: usize) {
    for value in &batch.center[index * 3..index * 3 + 3] {
        push_float(output, *value);
    }
    push_float(output, batch.opacity[index]);
    for value in &batch.rgb[index * 3..index * 3 + 3] {
        push_float(output, *value);
    }
    for value in &batch.scale[index * 3..index * 3 + 3] {
        push_float(output, *value);
    }
    for value in &batch.quat[index * 4..index * 4 + 4] {
        push_float(output, *value);
    }
    if max_sh_degree >= 1 {
        for value in &batch.sh1[index * 9..index * 9 + 9] {
            push_float(output, *value);
        }
    }
    if max_sh_degree >= 2 {
        for value in &batch.sh2[index * 15..index * 15 + 15] {
            push_float(output, *value);
        }
    }
    if max_sh_degree >= 3 {
        for value in &batch.sh3[index * 21..index * 21 + 21] {
            push_float(output, *value);
        }
    }
}

#[derive(Clone)]
struct Bucket {
    path: PathBuf,
    count: usize,
    cell: usize,
    part: usize,
}

fn bucket_stage(
    stage: &mut StageReader,
    bucket_dir: &Path,
    target: usize,
) -> Result<(Vec<Bucket>, usize)> {
    fs::create_dir_all(bucket_dir)?;
    let ideal_cells = stage.num_splats.div_ceil(target).saturating_mul(2).max(1);
    let grid_dim = (ideal_cells as f64)
        .cbrt()
        .ceil()
        .clamp(1.0, MAX_GRID_DIM as f64) as usize;
    let mut cell_counts = vec![0usize; grid_dim * grid_dim * grid_dim];
    let mut part_counts = HashMap::<(usize, usize), usize>::new();
    let extent = [
        (stage.bounds_max[0] - stage.bounds_min[0]).max(1.0e-9),
        (stage.bounds_max[1] - stage.bounds_min[1]).max(1.0e-9),
        (stage.bounds_max[2] - stage.bounds_min[2]).max(1.0e-9),
    ];

    for base in (0..stage.num_splats).step_by(PROPERTY_BATCH) {
        let count = (stage.num_splats - base).min(PROPERTY_BATCH);
        let batch = Batch::read(stage, base, count)?;
        let mut groups = HashMap::<(usize, usize), Vec<u8>>::new();

        for index in 0..count {
            let mut grid = [0usize; 3];
            for axis in 0..3 {
                let normalized =
                    (batch.center[index * 3 + axis] - stage.bounds_min[axis]) / extent[axis];
                grid[axis] = ((normalized.clamp(0.0, 0.999_999) * grid_dim as f32) as usize)
                    .min(grid_dim - 1);
            }
            let cell = grid[0] + grid_dim * (grid[1] + grid_dim * grid[2]);
            let part = cell_counts[cell] / target;
            cell_counts[cell] += 1;
            *part_counts.entry((cell, part)).or_default() += 1;
            append_record(
                groups.entry((cell, part)).or_default(),
                &batch,
                index,
                stage.max_sh_degree,
            );
        }

        for ((cell, part), bytes) in groups {
            let path = bucket_dir.join(format!("cell-{cell:03}-part-{part:04}.bin"));
            let mut file = OpenOptions::new().create(true).append(true).open(path)?;
            file.write_all(&bytes)?;
        }
        println!(
            "STREAM_PROGRESS bucket {} {}",
            base + count,
            stage.num_splats
        );
    }

    let mut buckets = part_counts
        .into_iter()
        .map(|((cell, part), count)| Bucket {
            path: bucket_dir.join(format!("cell-{cell:03}-part-{part:04}.bin")),
            count,
            cell,
            part,
        })
        .collect::<Vec<_>>();
    buckets.sort_by_key(|bucket| (bucket.cell, bucket.part));
    Ok((buckets, grid_dim))
}

fn cell_bounds(
    cell: usize,
    grid_dim: usize,
    bounds_min: [f32; 3],
    bounds_max: [f32; 3],
) -> ([f32; 3], [f32; 3]) {
    let grid = [
        cell % grid_dim,
        (cell / grid_dim) % grid_dim,
        cell / (grid_dim * grid_dim),
    ];
    let mut cell_min = [0.0; 3];
    let mut cell_max = [0.0; 3];
    for axis in 0..3 {
        let extent = bounds_max[axis] - bounds_min[axis];
        cell_min[axis] = bounds_min[axis] + extent * grid[axis] as f32 / grid_dim as f32;
        cell_max[axis] = bounds_min[axis] + extent * (grid[axis] + 1) as f32 / grid_dim as f32;
    }
    (cell_min, cell_max)
}

fn read_record_floats(
    reader: &mut BufReader<File>,
    floats: usize,
    output: &mut Vec<f32>,
) -> Result<()> {
    let mut bytes = vec![0u8; floats * 4];
    reader.read_exact(&mut bytes)?;
    output.resize(floats, 0.0);
    for (value, chunk) in output.iter_mut().zip(bytes.chunks_exact(4)) {
        *value = f32::from_le_bytes(chunk.try_into().unwrap());
    }
    Ok(())
}

fn load_bucket(bucket: &Bucket, max_sh_degree: usize) -> Result<GsplatArray> {
    let mut splats = GsplatArray::new();
    splats.init_splats(&SplatInit {
        num_splats: bucket.count,
        max_sh_degree,
        lod_tree: false,
    })?;
    let mut reader = BufReader::new(File::open(&bucket.path)?);
    let floats_per_record = record_float_count(max_sh_degree);
    let mut record = Vec::new();

    for base in (0..bucket.count).step_by(LOAD_BATCH) {
        let count = (bucket.count - base).min(LOAD_BATCH);
        let mut batch = Batch {
            center: Vec::with_capacity(count * 3),
            opacity: Vec::with_capacity(count),
            rgb: Vec::with_capacity(count * 3),
            scale: Vec::with_capacity(count * 3),
            quat: Vec::with_capacity(count * 4),
            sh1: Vec::with_capacity(if max_sh_degree >= 1 { count * 9 } else { 0 }),
            sh2: Vec::with_capacity(if max_sh_degree >= 2 { count * 15 } else { 0 }),
            sh3: Vec::with_capacity(if max_sh_degree >= 3 { count * 21 } else { 0 }),
        };
        for _ in 0..count {
            read_record_floats(&mut reader, floats_per_record, &mut record)?;
            let mut cursor = 0;
            batch.center.extend_from_slice(&record[cursor..cursor + 3]);
            cursor += 3;
            batch.opacity.push(record[cursor]);
            cursor += 1;
            batch.rgb.extend_from_slice(&record[cursor..cursor + 3]);
            cursor += 3;
            batch.scale.extend_from_slice(&record[cursor..cursor + 3]);
            cursor += 3;
            batch.quat.extend_from_slice(&record[cursor..cursor + 4]);
            cursor += 4;
            if max_sh_degree >= 1 {
                batch.sh1.extend_from_slice(&record[cursor..cursor + 9]);
                cursor += 9;
            }
            if max_sh_degree >= 2 {
                batch.sh2.extend_from_slice(&record[cursor..cursor + 15]);
                cursor += 15;
            }
            if max_sh_degree >= 3 {
                batch.sh3.extend_from_slice(&record[cursor..cursor + 21]);
            }
        }
        splats.set_batch(
            base,
            count,
            &SplatProps {
                center: &batch.center,
                opacity: &batch.opacity,
                rgb: &batch.rgb,
                scale: &batch.scale,
                quat: &batch.quat,
                sh1: &batch.sh1,
                sh2: &batch.sh2,
                sh3: &batch.sh3,
                ..Default::default()
            },
        );
    }
    Ok(splats)
}

fn stream_decode(input: &Path, stage_dir: PathBuf) -> Result<DiskStageReceiver> {
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "splat" {
        return stream_decode_splat(input, stage_dir);
    }
    anyhow::ensure!(
        extension == "ply" || extension == "spz",
        "bounded-memory decoding currently supports .ply, .spz and .splat; convert this input before processing"
    );
    let receiver = DiskStageReceiver::new(stage_dir);
    let input_string = input.to_string_lossy();
    let mut decoder = MultiDecoder::new(receiver, None, Some(&input_string));
    let mut reader = BufReader::new(File::open(input)?);
    let mut buffer = vec![0u8; INPUT_CHUNK_BYTES];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        decoder.push(&buffer[..count])?;
    }
    decoder.finish()?;
    Ok(decoder.into_splats())
}

fn stream_decode_splat(input: &Path, stage_dir: PathBuf) -> Result<DiskStageReceiver> {
    const RECORD_BYTES: usize = 32;
    let file_len = fs::metadata(input)?.len() as usize;
    anyhow::ensure!(file_len % RECORD_BYTES == 0, "invalid .splat file length");
    let num_splats = file_len / RECORD_BYTES;
    let mut receiver = DiskStageReceiver::new(stage_dir);
    receiver.init_splats(&SplatInit {
        num_splats,
        max_sh_degree: 0,
        lod_tree: false,
    })?;
    let mut reader = BufReader::new(File::open(input)?);
    let mut base = 0usize;
    while base < num_splats {
        let count = (num_splats - base).min(PROPERTY_BATCH);
        let mut bytes = vec![0u8; count * RECORD_BYTES];
        reader.read_exact(&mut bytes)?;
        let mut center = vec![0.0; count * 3];
        let mut opacity = vec![0.0; count];
        let mut rgb = vec![0.0; count * 3];
        let mut scale = vec![0.0; count * 3];
        let mut quat = vec![0.0; count * 4];
        for index in 0..count {
            let record = &bytes[index * RECORD_BYTES..(index + 1) * RECORD_BYTES];
            let read =
                |offset: usize| f32::from_le_bytes(record[offset..offset + 4].try_into().unwrap());
            center[index * 3] = read(0);
            center[index * 3 + 1] = read(4);
            center[index * 3 + 2] = read(8);
            scale[index * 3] = read(12);
            scale[index * 3 + 1] = read(16);
            scale[index * 3 + 2] = read(20);
            rgb[index * 3] = record[24] as f32 / 255.0;
            rgb[index * 3 + 1] = record[25] as f32 / 255.0;
            rgb[index * 3 + 2] = record[26] as f32 / 255.0;
            opacity[index] = record[27] as f32 / 255.0;
            quat[index * 4] = (record[29] as f32 - 128.0) / 128.0;
            quat[index * 4 + 1] = (record[30] as f32 - 128.0) / 128.0;
            quat[index * 4 + 2] = (record[31] as f32 - 128.0) / 128.0;
            quat[index * 4 + 3] = (record[28] as f32 - 128.0) / 128.0;
        }
        receiver.set_batch(
            base,
            count,
            &SplatProps {
                center: &center,
                opacity: &opacity,
                rgb: &rgb,
                scale: &scale,
                quat: &quat,
                ..Default::default()
            },
        );
        base += count;
    }
    receiver.finish()?;
    Ok(receiver)
}

fn output_paths(input: &Path) -> Result<(PathBuf, PathBuf)> {
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .context("input filename is not valid UTF-8")?;
    let output_dir = parent.join(format!("{stem}-lod-stream"));
    let scratch_dir = parent.join(format!(".{stem}-lod-scratch"));
    Ok((output_dir, scratch_dir))
}

pub fn process_streaming(
    input: &Path,
    memory_limit_mb: usize,
    max_sh: Option<usize>,
    quality: StreamingQuality,
    requested_threads: usize,
    output_override: Option<&Path>,
    scratch_override: Option<&Path>,
) -> Result<PathBuf> {
    apply_hard_memory_limit(memory_limit_mb)?;
    let (default_output_dir, default_scratch_dir) = output_paths(input)?;
    let output_dir = output_override.unwrap_or(&default_output_dir).to_path_buf();
    let scratch_dir = scratch_override
        .unwrap_or(&default_scratch_dir)
        .to_path_buf();
    anyhow::ensure!(
        output_dir != scratch_dir,
        "output and scratch directories must differ"
    );
    if output_dir.exists() {
        fs::remove_dir_all(&output_dir)?;
    }
    if scratch_dir.exists() {
        fs::remove_dir_all(&scratch_dir)?;
    }
    fs::create_dir_all(&output_dir)?;
    fs::create_dir_all(&scratch_dir)?;

    println!("STREAM_PHASE decode");
    println!("STREAM_MEMORY_LIMIT_MB {memory_limit_mb}");
    println!("STREAM_QUALITY {}", quality.as_str());
    let stage = stream_decode(input, scratch_dir.join("stage"))?;
    anyhow::ensure!(stage.num_splats > 0, "input contains no splats");
    let max_sh_degree = stage.max_sh_degree.min(max_sh.unwrap_or(3));
    let hardware_threads = std::thread::available_parallelism().map(usize::from).unwrap_or(1);
    let memory_threads = (memory_limit_mb / 1024).max(1);
    let threads = if requested_threads == 0 {
        hardware_threads.min(memory_threads).min(8)
    } else {
        requested_threads.min(hardware_threads).min(memory_threads).max(1)
    };
    // Reserve 40% for decoder metadata, encoder buffers and the OS. Each
    // worker receives an equal slice so parallel tiles remain under the hard cap.
    let worker_memory_bytes = memory_limit_mb * 1024 * 1024 * 3 / 5 / threads;
    let target = (worker_memory_bytes / BYTES_PER_SPLAT_BUDGET)
        .clamp(MIN_TILE_SPLATS, MAX_TILE_SPLATS);
    println!("STREAM_ACCELERATOR cpu-rayon");
    println!("STREAM_THREADS {threads}");
    println!(
        "STREAM_INPUT splats={} sh={} target_tile_splats={}",
        stage.num_splats, max_sh_degree, target
    );

    println!("STREAM_PHASE bucket");
    let mut stage_reader = StageReader::open(&stage)?;
    stage_reader.max_sh_degree = max_sh_degree;
    let (buckets, grid_dim) =
        bucket_stage(&mut stage_reader, &scratch_dir.join("buckets"), target)?;
    println!("STREAM_BUCKETS {}", buckets.len());

    println!("STREAM_PHASE lod");
    struct TileResult {
        tile: serde_json::Value,
        output_splats: usize,
        valid_source_splats: usize,
    }
    let completed = std::sync::atomic::AtomicUsize::new(0);
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    let results: Vec<Result<Option<TileResult>>> = pool.install(|| buckets.par_iter().enumerate().map(|(tile_index, bucket)| {
        println!(
            "STREAM_TILE_BEGIN {} {} {}",
            tile_index + 1,
            buckets.len(),
            bucket.count
        );
        let mut splats = load_bucket(bucket, max_sh_degree)?;
        splats.remove_invalid();
        if splats.len() == 0 {
            fs::remove_file(&bucket.path)?;
            return Ok(None);
        }
        let leaf_splats = splats.len();
        bhatt_lod::compute_lod_tree(&mut splats, 1.75, |message| {
            if message.starts_with("Level:") {
                println!("STREAM_LOD {message}");
            }
        });
        chunk_tree::chunk_tree(&mut splats, 0, |_| {});
        splats.encode_lod_opacity();

        let tile_name = format!("tile-{tile_index:05}");
        let header_name = format!("{tile_name}.rad");
        let mut encoder = configure_rad_encoder(splats, quality);
        let mut header = BufWriter::new(File::create(output_dir.join(&header_name))?);
        let chunks = encoder.encode_with_chunks(&mut header, &format!("{tile_name}-"))?;
        for (filename, bytes) in chunks {
            let mut writer = BufWriter::new(File::create(output_dir.join(filename))?);
            writer.write_all(&bytes)?;
        }
        header.flush()?;
        let tile_splats = encoder.getter.num_splats();
        let (tile_bounds_min, tile_bounds_max) =
            cell_bounds(bucket.cell, grid_dim, stage.bounds_min, stage.bounds_max);
        let tile = serde_json::json!({
            "url": header_name,
            "splats": tile_splats,
            "sourceSplats": bucket.count,
            "validSourceSplats": leaf_splats,
            "cell": bucket.cell,
            "part": bucket.part,
            "bounds": { "min": tile_bounds_min, "max": tile_bounds_max },
        });
        fs::remove_file(&bucket.path)?;
        let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        println!("STREAM_TILE_DONE {} {}", done, buckets.len());
        Ok(Some(TileResult { tile, output_splats: tile_splats, valid_source_splats: leaf_splats }))
    }).collect());
    let mut tiles = Vec::with_capacity(results.len());
    let mut output_splats = 0usize;
    let mut valid_source_splats = 0usize;
    for result in results {
        if let Some(result) = result? {
            tiles.push(result.tile);
            output_splats += result.output_splats;
            valid_source_splats += result.valid_source_splats;
        }
    }

    println!("STREAM_PHASE manifest");
    let manifest_path = output_dir.join("manifest.json");
    let manifest = serde_json::json!({
        "format": "spark-rad-manifest-v1",
        "source": input.file_name().and_then(|name| name.to_str()).unwrap_or("model"),
        "sourceSplats": stage.num_splats,
        "validSourceSplats": valid_source_splats,
        "splats": output_splats,
        "qualityProfile": quality.as_str(),
        "sourcePrecision": quality.precision_description(),
        "sourceLeavesPreserved": true,
        "memoryLimitMb": memory_limit_mb,
        "targetTileSplats": target,
        "gridDim": grid_dim,
        "bounds": { "min": stage.bounds_min, "max": stage.bounds_max },
        "tiles": tiles,
    });
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
    fs::remove_dir_all(&scratch_dir)?;
    println!("STREAM_DONE {}", manifest_path.display());
    Ok(manifest_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_profile_writes_float32_rad_properties() -> Result<()> {
        let mut splats = GsplatArray::new();
        splats.init_splats(&SplatInit {
            num_splats: 2,
            max_sh_degree: 1,
            lod_tree: false,
        })?;
        let center = [-1.0, 0.0, -2.0, 1.0, 0.0, -2.0];
        let opacity = [0.5, 0.75];
        let rgb = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9];
        let scale = [0.1, 0.2, 0.3, 0.3, 0.2, 0.1];
        let quat = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let sh1 = [0.03125; 18];
        splats.set_batch(
            0,
            2,
            &SplatProps {
                center: &center,
                opacity: &opacity,
                rgb: &rgb,
                scale: &scale,
                quat: &quat,
                sh1: &sh1,
                ..Default::default()
            },
        );

        let mut encoder = configure_rad_encoder(splats, StreamingQuality::Original);
        let mut header = Vec::new();
        let chunks = encoder.encode_with_chunks(&mut header, "test-")?;
        let chunk = &chunks[0].1;
        anyhow::ensure!(&chunk[..4] == b"RADC", "missing RADC magic");
        let meta_len = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&chunk[8..8 + meta_len])?;
        let properties = meta["properties"]
            .as_array()
            .context("properties missing")?;
        let encoding = |name: &str| {
            properties
                .iter()
                .find(|property| property["property"] == name)
                .and_then(|property| property["encoding"].as_str())
        };

        assert_eq!(encoding("center"), Some("f32_lebytes"));
        for property in ["alpha", "rgb", "scales", "orientation", "sh1"] {
            assert_eq!(encoding(property), Some("f32"), "{property}");
        }
        Ok(())
    }
}

#[cfg(windows)]
fn apply_hard_memory_limit(memory_limit_mb: usize) -> Result<()> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        anyhow::ensure!(
            !job.is_null(),
            "CreateJobObjectW failed: {}",
            GetLastError()
        );
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        info.ProcessMemoryLimit = memory_limit_mb * 1024 * 1024;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        anyhow::ensure!(
            configured != 0,
            "SetInformationJobObject failed: {}",
            GetLastError()
        );
        let assigned = AssignProcessToJobObject(job, GetCurrentProcess());
        anyhow::ensure!(
            assigned != 0,
            "AssignProcessToJobObject failed: {}",
            GetLastError()
        );
        // Raw HANDLE values are not dropped by Rust. Keeping it open for the
        // process lifetime keeps the hard memory limit active.
        let _job_handle = job;
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_hard_memory_limit(_memory_limit_mb: usize) -> Result<()> {
    Ok(())
}
