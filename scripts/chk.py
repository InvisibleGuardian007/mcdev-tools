# -*- coding: utf-8 -*-
import gui, _gui
S = 'settings.screen_world_controls_and_settings'
TOGGLE = ('/variables_button_mappings_and_controls/safezone_screen_matrix/inner_matrix/safezone_screen_panel'
          '/root_screen_panel/stack_panel/content_panel/container/settings_common.dialog_content'
          '/selector_area/scrolling_panel/scroll_touch/scroll_view/panel/background_and_viewport'
          '/scrolling_view_port/scrolling_content/settings.selector_stack_panel'
          '/controls_and_settings_selector_pane/video_button/video_button_toggle')
r = {}
r['screens'] = gui.get_all_screen_fullnames()
try:
    r['size'] = gui.get_size(S, TOGGLE)
    r['vis'] = gui.get_visible(S, TOGGLE)
except Exception as e:
    r['err'] = str(e)[:100]
try:
    r['roots'] = _gui.get_root_children_names(S)
except Exception as e:
    r['roots_err'] = str(e)[:80]
_result = r
