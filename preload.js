const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gameAPI', {
  // 读取存档索引（不含 canvas 数据）
  readIndex: () => ipcRenderer.invoke('game:read-index'),
  writeIndex: (data) => ipcRenderer.invoke('game:write-index', data),
  // 读取/写入单个闯关 meta.json
  readMeta: (saveId) => ipcRenderer.invoke('game:read-meta', saveId),
  writeMeta: (saveId, meta) => ipcRenderer.invoke('game:write-meta', saveId, meta),
  // 图层瓦片 PNG（base64）：一层一个目录，按 "tx,ty" 索引；旧版单图作为 legacy 回退
  readLayer: (saveId, levelIdx, layerIdx) => ipcRenderer.invoke('game:read-layer', saveId, levelIdx, layerIdx),
  writeLayer: (saveId, levelIdx, layerIdx, dataUrl) => ipcRenderer.invoke('game:write-layer', saveId, levelIdx, layerIdx, dataUrl),
  readLayerTiles: (saveId, levelIdx, layerIdx) => ipcRenderer.invoke('game:read-layer-tiles', saveId, levelIdx, layerIdx),
  writeLayerTiles: (saveId, levelIdx, layerIdx, tiles) => ipcRenderer.invoke('game:write-layer-tiles', saveId, levelIdx, layerIdx, tiles),
  // 自定义音乐
  readCustomMusic: (saveId) => ipcRenderer.invoke('game:read-custom-music', saveId),
  writeCustomMusic: (saveId, dataUrl) => ipcRenderer.invoke('game:write-custom-music', saveId, dataUrl),
  deleteSave: (saveId) => ipcRenderer.invoke('game:delete-save', saveId),
  // 导出 .hgyx 闯关包（弹系统「另存为」对话框；mode: 'full' | 'play'）
  exportSave: (saveId, mode, name) => ipcRenderer.invoke('game:export-save', saveId, mode, name),
  // 导入 .hgyx 闯关包（弹系统「打开文件」对话框，只列 *.hgyx）
  importSave: () => ipcRenderer.invoke('game:import-save'),
  saveThumbnail: (saveId, dataUrl) => ipcRenderer.invoke('game:save-thumbnail', saveId, dataUrl),
  captureThumbnail: (saveId, canvasScale, cx, cy) => ipcRenderer.invoke('game:capture-thumbnail', saveId, canvasScale, cx, cy),
  readThumbnail: (saveId) => ipcRenderer.invoke('game:read-thumbnail', saveId),
  onCloseRequest: (cb) => ipcRenderer.on('app:close-request', cb),
  forceQuit: () => ipcRenderer.send('app:force-quit'),
  // 旧 localStorage 迁移
  migrateFromLocal: () => ipcRenderer.invoke('game:migrate-local'),
});
