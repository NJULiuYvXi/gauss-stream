const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("gaussDesktop", {
  pickModel: () => ipcRenderer.invoke("desktop:pick-model"),
  inspectDroppedModel: (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath)
      throw new Error("无法读取拖入文件的本地路径，请改用“选择模型”");
    return ipcRenderer.invoke("desktop:inspect-model-path", filePath);
  },
  pickExistingLod: () => ipcRenderer.invoke("desktop:pick-existing-lod"),
  openDroppedAsset: (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (!filePath)
      throw new Error("无法读取拖入文件的本地路径，请改用“打开已有 LOD”");
    return ipcRenderer.invoke("desktop:open-existing-path", filePath);
  },
  startModel: (selectionId, memoryLimitMb, qualityProfile) =>
    ipcRenderer.invoke(
      "desktop:start-model",
      selectionId,
      memoryLimitMb,
      qualityProfile,
    ),
  discardSelection: (selectionId) =>
    ipcRenderer.invoke("desktop:discard-selection", selectionId),
});
