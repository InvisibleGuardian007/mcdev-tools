
import threading, time, yappi, sys

def marker_c(): pass
def marker_s(): pass

ready = threading.Event()
go = threading.Event()
result = {}

def worker():
    ready.set()
    go.wait()
    # 'server' side executes its marker here, on a thread created BEFORE yappi.start()
    marker_s()
    result['server_tid'] = threading.current_thread().name

t = threading.Thread(target=worker, name='ServerThread')
t.daemon = True
t.start()
ready.wait()

yappi.set_clock_type('cpu')
yappi.start(False, True)   # builtins=False, profile_threads=True
marker_c()                 # 'client' marker on the calling (main) thread
go.set()
t.join()
yappi.stop()

stats = list(yappi.get_func_stats())
names = {}
for s in stats:
    n = getattr(s, 'name', '')
    if n in ('marker_c', 'marker_s'):
        names[n] = int(getattr(s, 'ctx_id', -1) or 0)
print('default-filter marker ctx:', names)
print('total top-level stats:', len(stats))
for ctx in (0,1,2,3):
    try:
        cs = list(yappi.get_func_stats({'ctx_id': ctx}))
        hit = [getattr(s,'name','') for s in cs if getattr(s,'name','').startswith('marker')]
        print('ctx', ctx, 'stats', len(cs), 'markers', hit)
    except Exception as e:
        print('ctx', ctx, 'error', e)
