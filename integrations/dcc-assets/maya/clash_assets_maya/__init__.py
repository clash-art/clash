"""Clash Materials for Maya. Entry point: import clash_assets_maya; clash_assets_maya.show()."""
from pathlib import Path
import base64
import tempfile
import maya.cmds as cmds
import maya.OpenMayaUI as omui
try:
    from PySide6 import QtCore, QtGui, QtWidgets
    from shiboken6 import wrapInstance
except ImportError:
    from PySide2 import QtCore, QtGui, QtWidgets
    from shiboken2 import wrapInstance
from .bridge import AssetBridge, BridgeError
from .control import ControlServer, Pending
from .native import execute_python, workspace_file
from .maya_tools import catalog as maya_catalog, invoke as maya_invoke

_window = None
_tools_root = Path(__file__).parent / 'mayatools'


def _import_texture(path, asset_id):
    if path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp', '.avif'}:
        raise BridgeError('Native Maya import currently supports raster image textures. Copy saved at ' + str(path))
    cmds.undoInfo(openChunk=True, chunkName='Import Clash texture')
    try:
        node = cmds.shadingNode('file', asTexture=True, name='clashTexture')
        cmds.setAttr(node + '.fileTextureName', str(path), type='string')
        cmds.addAttr(node, longName='clashAssetId', dataType='string')
        cmds.setAttr(node + '.clashAssetId', asset_id, type='string')
    finally:
        cmds.undoInfo(closeChunk=True)
    return dict(node=node, file=str(path), assetId=asset_id)


def _scene_info():
    return dict(file=cmds.file(query=True, sceneName=True), frame=cmds.currentTime(query=True),
                objects=cmds.ls(type='transform', long=True) or [], selection=cmds.ls(selection=True, long=True) or [])


def _object_info(name):
    if not isinstance(name, str) or not cmds.objExists(name):
        raise BridgeError('Object not found: ' + str(name))
    matches = cmds.ls(name, long=True) or []
    if len(matches) != 1:
        raise BridgeError('Object name is ambiguous. Use its full DAG path.')
    name = matches[0]
    value = dict(name=name, type=cmds.nodeType(name), children=cmds.listRelatives(name, children=True, fullPath=True) or [])
    if cmds.objectType(name, isAType='transform'):
        value['matrixWorld'] = cmds.xform(name, query=True, matrix=True, worldSpace=True)
    value['shadingGroups'] = sorted(set(group for shape in [name, *value['children']]
                                      for group in (cmds.listConnections(shape, type='shadingEngine') or [])))
    if cmds.attributeQuery('clashAssetId', node=name, exists=True):
        value['assetId'] = cmds.getAttr(name + '.clashAssetId')
    return value


def _screenshot():
    panels = cmds.getPanel(type='modelPanel') or []
    if not panels:
        raise BridgeError('Open a model viewport before requesting a screenshot.')
    focused = cmds.getPanel(withFocus=True)
    panel = focused if focused in panels else panels[0]
    with tempfile.TemporaryDirectory(prefix='clash-viewport-') as folder:
        path = Path(folder) / 'viewport.png'
        cmds.playblast(format='image', compression='png', completeFilename=str(path),
                       editorPanelName=panel, viewer=False, frame=cmds.currentTime(query=True),
                       offScreen=True, widthHeight=[960, 540], percent=100)
        if not path.is_file():
            raise BridgeError('Maya did not produce the requested viewport PNG.')
        return dict(mimeType='image/png', data=base64.b64encode(path.read_bytes()).decode())


class MaterialsWindow(QtWidgets.QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setObjectName('ClashMaterialsWindow')
        self.setWindowTitle('Clash · Materials')
        self.resize(460, 690)
        self.setMinimumSize(360, 520)
        self.job = None
        self.control = None
        self.finish = None
        self.assets = []
        self.setStyleSheet('''
            QDialog#ClashMaterialsWindow { font-size: 13px; }
            QLabel#title { font-size: 25px; font-weight: 600; }
            QLabel#subtitle { padding-bottom: 12px; }
            QLineEdit { padding: 7px; border-radius: 5px; }
            QTreeWidget { border: 0; border-radius: 8px; }
            QTreeWidget::item { padding: 8px 4px; }
            QPushButton { padding: 9px 12px; border-radius: 6px; }
            QPushButton#send { background: #FF6B50; color: #181818; font-weight: 600; border: 0; }
            QPushButton#send:hover { background: #FF836D; }
            QPushButton#send:disabled { background: palette(mid); color: palette(text); }
            QPushButton:focus, QLineEdit:focus { border: 1px solid #FF6B50; }
            QProgressBar { max-height: 3px; border: 0; }
            QProgressBar::chunk { background: #FF6B50; }
        ''')
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(24, 24, 24, 20)
        layout.setSpacing(12)
        title = QtWidgets.QLabel('Materials')
        title.setObjectName('title')
        layout.addWidget(title)
        subtitle = QtWidgets.QLabel('Your Clash project, within reach.')
        subtitle.setObjectName('subtitle')
        layout.addWidget(subtitle)

        self.connection_toggle = QtWidgets.QToolButton()
        self.connection_toggle.setText('Connection')
        self.connection_toggle.setToolButtonStyle(QtCore.Qt.ToolButtonTextBesideIcon)
        self.connection_toggle.setCheckable(True)
        self.connection_toggle.setArrowType(QtCore.Qt.RightArrow)
        layout.addWidget(self.connection_toggle)
        self.connection = QtWidgets.QWidget()
        form = QtWidgets.QFormLayout(self.connection)
        form.setContentsMargins(0, 4, 0, 8)
        self.folder = QtWidgets.QLineEdit(self._saved('clashMaterialsFolder', ''))
        self.folder.setPlaceholderText('Clash project working folder')
        self.folder.setAccessibleName('Clash project working folder')
        browse = QtWidgets.QToolButton()
        browse.setText('…')
        browse.setToolTip('Choose working folder')
        browse.clicked.connect(self.choose_folder)
        folder_row = QtWidgets.QHBoxLayout()
        folder_row.addWidget(self.folder)
        folder_row.addWidget(browse)
        form.addRow('Folder', folder_row)
        self.cli = QtWidgets.QLineEdit(self._saved('clashMaterialsCli', 'clash'))
        self.cli.setAccessibleName('Clash executable path')
        form.addRow('Executable', self.cli)
        layout.addWidget(self.connection)
        self.agent = QtWidgets.QPushButton('Connect agent')
        self.agent.setToolTip('Enable full native Python control through the existing Clash MCP')
        self.agent.clicked.connect(self.toggle_agent)
        layout.addWidget(self.agent)
        self.connection_toggle.toggled.connect(self.toggle_connection)
        self.connection_toggle.setChecked(not bool(self.folder.text()))
        self.toggle_connection(self.connection_toggle.isChecked())

        heading = QtWidgets.QHBoxLayout()
        self.count = QtWidgets.QLabel('Project materials')
        heading.addWidget(self.count)
        heading.addStretch()
        self.refresh = QtWidgets.QPushButton('Refresh')
        self.refresh.setToolTip('Read available materials from the selected Clash project')
        self.refresh.clicked.connect(self.refresh_assets)
        heading.addWidget(self.refresh)
        layout.addLayout(heading)
        self.search = QtWidgets.QLineEdit()
        self.search.setPlaceholderText('Search materials…')
        self.search.setAccessibleName('Search materials')
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(self.filter_assets)
        layout.addWidget(self.search)

        self.list = QtWidgets.QTreeWidget()
        self.list.setAccessibleName('Project materials')
        self.list.setHeaderLabels(['Name', 'Type'])
        self.list.setRootIsDecorated(False)
        self.list.setSelectionMode(QtWidgets.QAbstractItemView.SingleSelection)
        self.list.header().setSectionResizeMode(0, QtWidgets.QHeaderView.Stretch)
        self.list.header().setSectionResizeMode(1, QtWidgets.QHeaderView.ResizeToContents)
        self.list.itemSelectionChanged.connect(self.update_actions)
        layout.addWidget(self.list, 1)

        receive_row = QtWidgets.QHBoxLayout()
        self.receive = QtWidgets.QPushButton('Receive copy')
        self.receive.setToolTip('Save an independent copy in assets/dcc; existing edits are preserved')
        self.receive.clicked.connect(lambda: self.receive_asset(False))
        self.texture = QtWidgets.QPushButton('Create texture')
        self.texture.setToolTip('Receive an image and create a Maya file texture node')
        self.texture.clicked.connect(lambda: self.receive_asset(True))
        receive_row.addWidget(self.receive)
        receive_row.addWidget(self.texture)
        layout.addLayout(receive_row)
        self.send = QtWidgets.QPushButton('Send file to Clash')
        self.send.setObjectName('send')
        self.send.clicked.connect(self.send_file)
        layout.addWidget(self.send)
        self.progress = QtWidgets.QProgressBar()
        self.progress.setRange(0, 0)
        self.progress.setTextVisible(False)
        self.progress.hide()
        layout.addWidget(self.progress)
        self.status = QtWidgets.QLabel('Choose a working folder, then refresh to see its materials.')
        self.status.setWordWrap(True)
        self.status.setTextFormat(QtCore.Qt.PlainText)
        self.status.setTextInteractionFlags(QtCore.Qt.TextSelectableByMouse)
        layout.addWidget(self.status)
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.poll)
        self.timer.start(250)
        self.folder.textChanged.connect(self.clear_assets)
        self.update_actions()

    @staticmethod
    def _saved(key, fallback):
        return cmds.optionVar(query=key) if cmds.optionVar(exists=key) else fallback

    def toggle_connection(self, opened):
        self.connection.setVisible(opened)
        self.connection_toggle.setArrowType(QtCore.Qt.DownArrow if opened else QtCore.Qt.RightArrow)

    def choose_folder(self):
        folder = QtWidgets.QFileDialog.getExistingDirectory(self, 'Clash project working folder', self.folder.text())
        if folder:
            self.folder.setText(folder)

    def clear_assets(self):
        if self.control:
            self.control.close()
            self.control = None
        self.assets = []
        self.list.clear()
        self.count.setText('Project materials')
        self.status.setText('Working folder changed. Refresh to read its materials.')
        self.update_actions()

    def client(self):
        bridge = AssetBridge(self.folder.text(), self.cli.text())
        cmds.optionVar(stringValue=('clashMaterialsFolder', self.folder.text()))
        cmds.optionVar(stringValue=('clashMaterialsCli', self.cli.text()))
        return bridge

    def begin(self, start, finish):
        if self.job or (self.control and self.control.busy):
            return
        try:
            self.job = start()
            self.finish = finish
            self.status.setText('Transferring…')
        except Exception as error:
            self.status.setText(str(error))
        self.update_actions()

    def poll(self):
        if self.control:
            try:
                self.control.poll()
            except Exception as error:
                self.status.setText(str(error))
            self.update_actions()
        if not self.job or not self.job.poll():
            return
        job, finish = self.job, self.finish
        self.job = self.finish = None
        try:
            if job.error:
                raise BridgeError(job.error)
            finish(job.value)
        except Exception as error:
            self.status.setText(str(error))
        self.update_actions()

    def update_actions(self):
        selected = self.selected()
        idle = self.job is None and not (self.control and self.control.busy)
        self.receive.setEnabled(idle and selected is not None)
        self.texture.setEnabled(idle and selected is not None and selected['kind'] == 'image')
        for widget in (self.refresh, self.send, self.connection, self.list):
            widget.setEnabled(idle)
        self.connection.setEnabled(idle and self.control is None)
        self.agent.setText('Disconnect agent · Clash MCP' if self.control else 'Connect agent')
        self.agent.setEnabled(self.job is None)
        self.progress.setVisible(not idle)

    def selected(self):
        items = self.list.selectedItems()
        return items[0].data(0, QtCore.Qt.UserRole) if items else None

    def filter_assets(self):
        query = self.search.text().casefold()
        for index in range(self.list.topLevelItemCount()):
            item = self.list.topLevelItem(index)
            hidden = query not in (item.text(0) + ' ' + item.text(1)).casefold()
            item.setHidden(hidden)
            if hidden:
                item.setSelected(False)

    def refresh_assets(self):
        self.begin(lambda: self.client().start_list(), self.show_assets)

    def show_assets(self, assets):
        self.assets = assets
        self.list.clear()
        for asset in assets:
            item = QtWidgets.QTreeWidgetItem([asset.get('name') or asset['id'], asset['kind'].title()])
            item.setData(0, QtCore.Qt.UserRole, asset)
            item.setToolTip(0, asset['id'])
            self.list.addTopLevelItem(item)
        self.filter_assets()
        self.count.setText(f'Project materials · {len(assets)}')
        self.status.setText('Select a material to receive a local copy.' if assets else 'No materials yet. Send a rendered image, texture, or video to get started.')

    def send_file(self):
        path, _ = QtWidgets.QFileDialog.getOpenFileName(self, 'Send material to Clash', self.folder.text(),
            'Materials (*.png *.jpg *.jpeg *.webp *.avif *.mp4 *.mov *.webm *.m4v *.mkv *.wav *.mp3 *.m4a *.aac *.flac *.ogg *.glb)')
        if path:
            self.begin(lambda: self.client().start_send(path), lambda value: self.status.setText('Sent to Clash · ' + value['assetId']))

    def receive_asset(self, as_texture):
        asset = self.selected()
        if not asset:
            return
        def finish(path):
            if as_texture:
                result = _import_texture(path, asset['id'])
                self.status.setText('Texture created · ' + result['node'] + '\n' + str(path))
            else:
                self.status.setText('Copy saved\n' + str(path))
        self.begin(lambda: self.client().start_receive(asset['id']), finish)

    def toggle_agent(self):
        try:
            if self.control:
                self.control.close()
                self.control = None
                self.status.setText('Agent control disconnected')
            else:
                client = self.client()
                self.control = ControlServer('maya', client.root, self.dispatch, blocked=lambda: self.job is not None)
                self.status.setText('Agent connected through Clash MCP · full native Python control')
        except Exception as error:
            self.status.setText(str(error))
        self.update_actions()

    def dispatch(self, action, params):
        self.status.setText('Agent · ' + action.replace('_', ' '))
        if action == 'capabilities':
            return dict(app='maya', version=cmds.about(version=True),
                        operations=['scene', 'object', 'screenshot', 'execute', 'import_asset', 'publish_file', 'maya_tools', 'maya_call'],
                        nativeImports=['raster image texture'], pythonAccess='full-local')
        if action == 'scene':
            return _scene_info()
        if action == 'object':
            return _object_info(params.get('name'))
        if action == 'screenshot':
            return _screenshot()
        if action == 'maya_tools':
            return dict(tools=maya_catalog(_tools_root))
        if action == 'maya_call':
            # Opening/new scenes reset Maya's undo queue; file operations are not undo chunks.
            chunk = params.get('tool') not in {'scene_new', 'scene_open', 'scene_save'}
            if chunk:
                cmds.undoInfo(openChunk=True, chunkName='Clash Maya tool')
            try:
                return maya_invoke(_tools_root, params.get('tool'), params.get('toolArguments'))
            finally:
                if chunk:
                    cmds.undoInfo(closeChunk=True)
        if action == 'execute':
            cmds.undoInfo(openChunk=True, chunkName='Clash agent')
            try:
                return execute_python(params.get('code'), {'cmds': cmds})
            finally:
                cmds.undoInfo(closeChunk=True)
        client = self.client()
        if action == 'import_asset':
            asset_id = params.get('assetId')
            if not isinstance(asset_id, str) or not asset_id.strip():
                raise BridgeError('A Project Asset ID is required.')
            return Pending(client.start_receive(asset_id), lambda path: _import_texture(path, asset_id))
        if action == 'publish_file':
            return Pending(client.start_send(workspace_file(client.root, params.get('file'))))
        raise BridgeError('Unsupported native operation in Maya: ' + str(action))

    def closeEvent(self, event):
        self.timer.stop()
        if self.job:
            self.job.cancel()
            self.job = None
        if self.control:
            self.control.close()
            self.control = None
        super().closeEvent(event)


def show():
    global _window
    if _window is not None:
        _window.close()
        _window.deleteLater()
    parent = wrapInstance(int(omui.MQtUtil.mainWindow()), QtWidgets.QWidget)
    _window = MaterialsWindow(parent)
    _window.show()
    _window.raise_()
    return _window
