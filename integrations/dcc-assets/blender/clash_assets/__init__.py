"""Clash material exchange for Blender. Install the packaged ZIP."""
bl_info = {
    'name': 'Clash Materials', 'author': 'Clash', 'version': (0, 1, 0),
    'blender': (4, 2, 0), 'location': '3D View > Sidebar > Clash',
    'description': 'Exchange project materials with Clash',
    'category': 'Import-Export',
}

from pathlib import Path
import base64
import tempfile
import uuid
import bpy
from bpy.props import StringProperty, CollectionProperty, IntProperty
from bpy_extras.io_utils import ImportHelper
from .bridge import AssetBridge, BridgeError
from .control import ControlServer, Pending
from .native import execute_python, workspace_file

_job = None
_finish = None
_control = None
_status = 'Choose your Clash project working folder in Connection.'


def _preferences(context=None):
    return (context or bpy.context).preferences.addons[__package__].preferences


def _client(context=None):
    prefs = _preferences(context)
    if not prefs.working_folder.strip():
        raise BridgeError('Choose the Clash project working folder in Connection first.')
    return AssetBridge(bpy.path.abspath(prefs.working_folder), prefs.cli)


def _import_file(path, asset_id):
    suffix = path.suffix.lower()
    if suffix == '.glb':
        before = set(bpy.data.objects)
        if 'FINISHED' not in bpy.ops.import_scene.gltf(filepath=str(path)):
            raise BridgeError('Blender cancelled GLB import. The local copy is retained.')
        for obj in set(bpy.data.objects) - before:
            obj['clash_asset_id'] = asset_id
        return 'Model imported · ' + path.name
    if suffix in {'.png', '.jpg', '.jpeg', '.webp', '.avif'}:
        image = bpy.data.images.load(str(path), check_existing=False)
        image['clash_asset_id'] = asset_id
        return 'Image loaded · ' + image.name
    raise BridgeError('Use Receive copy for this format. Native import supports GLB and raster images.')


def _export_selection():
    if not bpy.context.selected_objects:
        raise BridgeError('Select objects to export first.')
    if bpy.context.mode != 'OBJECT':
        raise BridgeError('Switch to Object Mode before exporting.')
    root = _client().root / 'assets' / 'dcc' / 'exports'
    root.mkdir(parents=True, exist_ok=True)
    path = root / ('selection-' + uuid.uuid4().hex + '.glb')
    result = bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True)
    if 'FINISHED' not in result:
        raise BridgeError('Blender cancelled export.')
    return path


def _scene_info():
    scene = bpy.context.scene
    return dict(file=bpy.data.filepath, scene=scene.name, frame=scene.frame_current,
                objects=[dict(name=obj.name, type=obj.type, selected=obj.select_get(),
                              assetId=obj.get('clash_asset_id')) for obj in scene.objects])


def _object_info(name):
    obj = bpy.context.scene.objects.get(name)
    if obj is None:
        raise BridgeError('Object not found in the current scene: ' + str(name))
    return dict(name=obj.name, type=obj.type, location=list(obj.location),
                rotationEuler=list(obj.rotation_euler), scale=list(obj.scale),
                matrixWorld=[list(row) for row in obj.matrix_world], dimensions=list(obj.dimensions),
                materials=[slot.material.name if slot.material else None for slot in obj.material_slots],
                assetId=obj.get('clash_asset_id'))


def _screenshot():
    view = next(((window, area) for window in bpy.context.window_manager.windows
                 for area in window.screen.areas if area.type == 'VIEW_3D'), None)
    if view is None:
        raise BridgeError('Open a 3D Viewport before requesting a screenshot.')
    window, area = view
    region = next(region for region in area.regions if region.type == 'WINDOW')
    scene = window.scene
    render = scene.render
    previous = (render.filepath, render.image_settings.file_format, render.resolution_x,
                render.resolution_y, render.resolution_percentage)
    try:
        with tempfile.TemporaryDirectory(prefix='clash-viewport-') as folder:
            path = Path(folder) / 'viewport.png'
            render.filepath = str(path)
            render.image_settings.file_format = 'PNG'
            render.resolution_x, render.resolution_y, render.resolution_percentage = 960, 540, 100
            with bpy.context.temp_override(window=window, area=area, region=region):
                if 'FINISHED' not in bpy.ops.render.opengl(write_still=True, view_context=True):
                    raise BridgeError('Viewport capture was cancelled.')
            return dict(mimeType='image/png', data=base64.b64encode(path.read_bytes()).decode())
    finally:
        render.filepath, render.image_settings.file_format, render.resolution_x, render.resolution_y, render.resolution_percentage = previous


def _dispatch(action, params):
    global _status
    _status = 'Agent · ' + action.replace('_', ' ')
    if action == 'capabilities':
        return dict(app='blender', version=bpy.app.version_string,
                    operations=['scene', 'object', 'screenshot', 'execute', 'import_asset', 'publish_file', 'export_selection'],
                    nativeImports=['GLB', 'raster image'], pythonAccess='full-local')
    if action == 'scene':
        return _scene_info()
    if action == 'object':
        return _object_info(params.get('name'))
    if action == 'screenshot':
        return _screenshot()
    if action == 'execute':
        return execute_python(params.get('code'), {'bpy': bpy})
    client = _client()
    if action == 'import_asset':
        asset_id = params.get('assetId')
        if not isinstance(asset_id, str) or not asset_id.strip():
            raise BridgeError('A Project Asset ID is required.')
        def finish(path):
            message = _import_file(path, asset_id)
            _message(message)
            return dict(assetId=asset_id, file=str(path), message=message)
        return Pending(client.start_receive(asset_id), finish)
    if action == 'publish_file':
        return Pending(client.start_send(workspace_file(client.root, params.get('file'))))
    if action == 'export_selection':
        path = _export_selection()
        return Pending(client.start_send(path), lambda value: dict(assetId=value['assetId'], file=str(path)))
    raise BridgeError('Unsupported native operation: ' + str(action))


def _begin(job, finish):
    global _job, _finish, _status
    _job, _finish, _status = job, finish, 'Transferring…'


def _tick():
    global _job, _finish, _status
    try:
        if _control:
            _control.poll()
        if _job and _job.poll():
            completed, callback = _job, _finish
            _job = _finish = None
            if completed.error:
                _status = completed.error
            else:
                callback(completed.value)
    except Exception as error:
        _status = str(error)
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                area.tag_redraw()
    return 0.3


def _message(value):
    global _status
    _status = ('Sent to Clash · ' + value['assetId']) if isinstance(value, dict) and 'assetId' in value else str(value)


def _set_assets(values):
    global _status
    wm = bpy.context.window_manager
    wm.clash_materials.clear()
    for value in values:
        item = wm.clash_materials.add()
        item.asset_id, item.kind = value['id'], value['kind']
        item.name = value.get('name') or value['id']
    wm.clash_material_index = 0
    _status = f'{len(values)} available materials' if values else 'No materials yet. Send a file to get started.'


def _connection_changed(self, context):
    global _status, _control
    if _control:
        _control.close()
        _control = None
    for wm in bpy.data.window_managers:
        if hasattr(wm, 'clash_materials'):
            wm.clash_materials.clear()
            wm.clash_material_index = 0
    _status = 'Working folder changed. Refresh to read its materials.'


class ClashPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__
    working_folder: StringProperty(name='Working folder', subtype='DIR_PATH', update=_connection_changed)
    cli: StringProperty(name='Clash executable', default='clash')

    def draw(self, context):
        self.layout.enabled = _job is None and _control is None
        self.layout.prop(self, 'working_folder')
        self.layout.prop(self, 'cli')


class ClashMaterial(bpy.types.PropertyGroup):
    asset_id: StringProperty()
    kind: StringProperty()


class CLASH_UL_materials(bpy.types.UIList):
    def draw_item(self, context, layout, data, item, icon, active_data, active_propname, index):
        icons = {'image': 'IMAGE_DATA', 'video': 'SEQUENCE', 'audio': 'SOUND', 'model': 'MESH_DATA'}
        layout.label(text=item.name, icon=icons.get(item.kind, 'FILE'))

    def filter_items(self, context, data, propname):
        items = getattr(data, propname)
        flags = [self.bitflag_filter_item if self.filter_name.lower() in item.name.lower() else 0 for item in items]
        return flags, []


class CLASH_OT_material_action(bpy.types.Operator):
    bl_idname = 'clash.material_action'
    bl_label = 'Clash material action'
    action: StringProperty()

    @classmethod
    def poll(cls, context):
        return _job is None and not (_control and _control.busy)

    def execute(self, context):
        global _status, _control
        try:
            client = _client(context)
            if self.action == 'connect':
                if _control:
                    _control.close()
                    _control = None
                    _status = 'Agent control disconnected'
                else:
                    _control = ControlServer('blender', client.root, _dispatch, blocked=lambda: _job is not None)
                    _status = 'Agent connected through Clash MCP'
            elif self.action == 'refresh':
                _begin(client.start_list(), _set_assets)
            elif self.action == 'export':
                _begin(client.start_send(_export_selection()), _message)
            else:
                wm = context.window_manager
                if not 0 <= wm.clash_material_index < len(wm.clash_materials):
                    raise BridgeError('Refresh and select a material first.')
                item = wm.clash_materials[wm.clash_material_index]
                asset_id = item.asset_id
                callback = (lambda path: _message(_import_file(path, asset_id))) if self.action == 'import' else (lambda path: _message('Saved copy · ' + str(path)))
                _begin(client.start_receive(asset_id), callback)
            return {'FINISHED'}
        except Exception as error:
            _status = str(error)
            self.report({'ERROR'}, _status)
            return {'CANCELLED'}


class CLASH_OT_send_file(bpy.types.Operator, ImportHelper):
    bl_idname = 'clash.send_file'
    bl_label = 'Send file to Clash'
    filename_ext = ''
    filter_glob: StringProperty(default='*.png;*.jpg;*.jpeg;*.webp;*.avif;*.mp4;*.mov;*.webm;*.m4v;*.mkv;*.wav;*.mp3;*.m4a;*.aac;*.flac;*.ogg;*.glb', options={'HIDDEN'})

    @classmethod
    def poll(cls, context):
        return _job is None and not (_control and _control.busy)

    def execute(self, context):
        try:
            _begin(_client(context).start_send(self.filepath), _message)
            return {'FINISHED'}
        except Exception as error:
            self.report({'ERROR'}, str(error))
            return {'CANCELLED'}


class CLASH_PT_materials(bpy.types.Panel):
    bl_label = 'Clash Materials'
    bl_idname = 'CLASH_PT_materials'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Clash'

    def draw(self, context):
        layout = self.layout
        layout.use_property_split = True
        layout.use_property_decorate = False
        row = layout.row()
        row.label(text='Project materials', icon='ASSET_MANAGER')
        row.operator('clash.material_action', text='', icon='FILE_REFRESH').action = 'refresh'
        wm = context.window_manager
        layout.template_list('CLASH_UL_materials', '', wm, 'clash_materials', wm, 'clash_material_index', rows=6)
        row = layout.row(align=True)
        row.enabled = bool(wm.clash_materials)
        row.operator('clash.material_action', text='Receive copy', icon='IMPORT').action = 'receive'
        native = row.row(align=True)
        native.enabled = (0 <= wm.clash_material_index < len(wm.clash_materials)
                          and wm.clash_materials[wm.clash_material_index].kind in {'image', 'model'})
        native.operator('clash.material_action', text='Import', icon='ADD').action = 'import'
        layout.separator()
        column = layout.column(align=True)
        column.scale_y = 1.25
        column.operator('clash.send_file', text='Send a file', icon='EXPORT')
        column.operator('clash.material_action', text='Send selected as GLB', icon='MESH_DATA').action = 'export'
        layout.separator()
        layout.label(text='Transferring…' if _job else 'Materials stay in your project', icon='TIME' if _job else 'INFO')
        # Wrapped feedback remains readable in a narrow sidebar.
        import textwrap
        for line in textwrap.wrap(_status, width=max(20, int(context.region.width / 7))):
            layout.label(text=line)


class CLASH_PT_connection(bpy.types.Panel):
    bl_label = 'Connection'
    bl_idname = 'CLASH_PT_connection'
    bl_parent_id = 'CLASH_PT_materials'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Clash'
    bl_options = {'DEFAULT_CLOSED'}

    def draw(self, context):
        column = self.layout.column()
        column.enabled = _job is None and _control is None
        column.prop(_preferences(context), 'working_folder')
        column.prop(_preferences(context), 'cli')
        self.layout.operator('clash.material_action', text='Disconnect agent' if _control else 'Connect agent', icon='LINKED' if _control else 'UNLINKED').action = 'connect'
        self.layout.label(text='Clash MCP · Connected' if _control else 'Full native Python control', icon='INFO')


_classes = (ClashPreferences, ClashMaterial, CLASH_UL_materials, CLASH_OT_material_action, CLASH_OT_send_file, CLASH_PT_materials, CLASH_PT_connection)


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    bpy.types.WindowManager.clash_materials = CollectionProperty(type=ClashMaterial)
    bpy.types.WindowManager.clash_material_index = IntProperty(default=0)
    bpy.app.timers.register(_tick, persistent=True)


def unregister():
    global _job, _finish, _control
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    if _job:
        _job.cancel()
    if _control:
        _control.close()
    _job = _finish = _control = None
    del bpy.types.WindowManager.clash_materials
    del bpy.types.WindowManager.clash_material_index
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
