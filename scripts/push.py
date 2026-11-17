# -*- coding: utf-8 -*-
import gui, time
S = 'settings.screen_world_controls_and_settings'
r = {}
attempts = [
    (S,),
    (S, False),
    (S, True),
    (S, None),
    (S, {}),
]
for i, args in enumerate(attempts):
    try:
        gui.push_screen(*args)
        time.sleep(0.7)
        now = gui.get_all_screen_fullnames()
        r['try%d' % i] = {'args': repr(args[1:]), 'ok': True, 'screens': now}
    except Exception as e:
        r['try%d' % i] = {'args': repr(args[1:]), 'err': str(e)[:70]}
_result = r
