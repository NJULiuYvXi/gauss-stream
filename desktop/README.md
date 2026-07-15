# Gauss Stream Desktop

Windows desktop application for the Spark 2.0 viewer and the bounded-memory,
out-of-core LOD processor. The shell and file dialog are native Electron APIs;
the 3D interface is the same web UI used by the browser build.

During feature development, double-click `..\start-gauss-stream-dev.cmd`. It
starts Electron directly from the current workspace and does not rebuild the
portable executable.

```powershell
npm install
npm start
```

Create a portable Windows executable:

```powershell
npm run dist
```

The LOD subprocess is placed in a Windows Job Object capped at the selected
memory limit (minimum 512 MiB). The
desktop picker and Explorer drag/drop pass the original local path directly to
the processor, so multi-gigabyte sources are not copied through the renderer or
into the C: drive. Before processing, the application analyzes the dataset and
host memory, recommends a bounded-memory limit, and allows the user to override
it. Generated RAD tiles are written beside the source using a unique
`*-lod-stream-<job>` directory. The browser build keeps its streaming upload
route and accepts the same selected memory limit.

Already processed data does not need to be rebuilt. Use **打开已有 LOD** to
select its `manifest.json` (or a standalone `.rad` file), or drag the manifest,
RAD file, or containing directory into the desktop window. The directory is
mounted read-only and tile data is served locally with HTTP Range requests.

New streaming builds expose three data precision profiles. `original` is the
default and preserves every valid source leaf plus all source attributes as
float32; RAD byte-plane transforms and Deflate remain lossless. `high` uses
float16 attributes, while `compact` uses the previous adaptive R8/S8/F16
quantization. A previously compact-encoded RAD cannot regain source precision
at view time and must be rebuilt once if original-quality data is required.

The development UI can be used before repackaging, but original/high builds
require a `build-lod.exe` compiled from the updated source. An older processor
is detected before launch and is allowed only for the explicit compact profile.
