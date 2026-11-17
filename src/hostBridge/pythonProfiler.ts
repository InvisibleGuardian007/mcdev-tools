export type PythonProfilerTarget = 'client' | 'server' | 'all';
export type PythonProfilerSide = Exclude<PythonProfilerTarget, 'all'>;
export type PythonProfilerClock = 'CPU' | 'WALL';

export interface PythonProfilerStartOptions {
    /** 起采样的那一端：脚本必须发到该端自己的线程上执行 */
    target: PythonProfilerSide;
    clock: PythonProfilerClock;
    durationSeconds?: number;
    /**
     * true = 这次采样要同时覆盖两端（target 为 'all' 时）。
     *
     * yappi 的 start(builtins, profile_threads) 里 profile_threads 为 True 时，除了给之后
     * 新建的线程装 hook（Python 2 的 threading.setprofile 只对之后新建的线程生效），
     * _yappi 还会枚举进程里**已经存在**的每条线程状态逐个挂钩子，所以已经跑着的
     * 服务端线程也能被采到；另一侧随后再用 buildPythonProfilerJoinCode 显式补挂自己。
     */
    allSides?: boolean;
}

export interface PythonProfilerFunction {
    id: number;
    target: PythonProfilerSide;
    module: string;
    line: number;
    name: string;
    calls: number;
    actualCalls: number;
    selfTime: number;
    totalTime: number;
    contextId: number;
    contextName: string;
    /** true = 属于当前 mod 的脚本；false = 引擎 / 原版函数 */
    isProject: boolean;
    /** 归属的 mod 脚本目录名（与运行时脚本名列表匹配）；'' = 引擎 / 原版 */
    mod?: string;
}

/** 单个 mod 的汇总，面板的 mod 列表与按 mod 导出的报告共用 */
export interface PythonProfilerModSummary {
    name: string;
    functions: number;
    calls: number;
    selfTime: number;
    totalTime: number;
}

export interface PythonProfilerCall {
    callerId: number;
    calleeId: number;
    calls: number;
    selfTime: number;
    totalTime: number;
}

export interface PythonProfilerResult {
    clock: PythonProfilerClock;
    elapsedSeconds: number;
    totalFunctions: number;
    /** 采集到的引擎（原版）函数数量，UI 默认折叠 */
    engineFunctions: number;
    truncated: boolean;
    functions: PythonProfilerFunction[];
    calls: PythonProfilerCall[];
    /** 按 mod 聚合的汇总（自身耗时多的在前），面板的 mod 列表直接用它 */
    mods?: PythonProfilerModSummary[];
    /** 实际采到的端（顺序 client → server）；单侧采集就是那一端 */
    targets?: PythonProfilerSide[];
    /** 'all' 时没挂上、没采到的那一端：两端同一次采样里漏掉一侧时如实记下来 */
    missingSides?: PythonProfilerSide[];
}

/**
 * 项目函数总预算：按 (端, mod) 组合的函数条数占比分配，而不是拿所有函数一起按耗时截断——
 * 一起截断时慢的 mod 会先被服务端的热函数挤空，客户端函数几乎必然整段消失，
 * 只采一个 mod 时也拿不到这个 mod 的全部函数。总量受回包体积约束（单次 executeCode 1 MiB）。
 */
const MAX_FUNCTIONS = 20000;
/** 每个 (端, mod) 组合的保底条数：再冷的端 / mod 也要留出位置，否则筛选里根本选不到 */
const MIN_FUNCTIONS_PER_GROUP = 24;
/** 引擎（原版）函数单独限流：默认折叠，展开时才看得到 */
const MAX_ENGINE_FUNCTIONS = 20000;
/**
 * 额外保留的「一跳邻居」：保留函数的直接调用者 / 被调用者即使本身不快也一起返回，
 * 否则调用详情里动不动就是「没有保留到项目内调用关系」。
 */
const MAX_EXTRA_FUNCTIONS = 20000;
/** 每个函数最多保留的出边数：现在是全量，这个值只是防呆 */
const MAX_EDGES_PER_FUNCTION = 100000;
const MAX_CALLS = 200000;
/**
 * 上面的条数上限只是防呆（真实采集一次几百到几千个函数，远达不到）。
 * 真正卡住回包体积的是桥接的单帧上限（16 MiB，见 HOST_BRIDGE_MAX_FRAME_BYTES），
 * 所以这里再按「估算字节数」收一刀：节点和边各留 7 MiB，超了才截断并标记 truncated。
 */
const MAX_NODE_BYTES = 7 * 1024 * 1024;
const MAX_EDGE_BYTES = 7 * 1024 * 1024;

export function buildPythonProfilerStartCode(options: PythonProfilerStartOptions): string {
    const duration = options.durationSeconds === undefined
        ? 'None'
        : String(validateDuration(options.durationSeconds));
    const clock = options.clock === 'WALL' ? 'WALL' : 'CPU';
    const allSides = options.allSides === true;
    return [
        'import yappi,threading,time',
        `_mcdev_pp_clock='${clock}'`,
        `_mcdev_pp_duration=${duration}`,
        `_mcdev_pp_all_sides=${allSides ? 'True' : 'False'}`,
        "if yappi.is_running() and not globals().get('_mcdev_pp_owned',False):",
        " _result={'ok':False,'reason':'busy'}",
        'else:',
        " _mcdev_pp_old=globals().get('_mcdev_pp_timer')",
        ' if _mcdev_pp_old: _mcdev_pp_old.cancel()',
        " if globals().get('_mcdev_pp_owned',False) and yappi.is_running(): yappi.stop()",
        ' yappi.clear_stats()',
        ' yappi.set_clock_type(_mcdev_pp_clock)',
        // profile_threads 只在 'all' 时打开：True 时 yappi 会把进程里已存在的线程一并挂钩
        // （服务端线程早就跑着了，光靠 threading.setprofile 采不到），单侧模式仍只盯当前线程。
        ' yappi.start(False,_mcdev_pp_all_sides)',
        " globals()['_mcdev_pp_owned']=True",
        " globals()['_mcdev_pp_joined']=False",
        " globals()['_mcdev_pp_all_sides']=_mcdev_pp_all_sides",
        " globals()['_mcdev_pp_started']=time.time()",
        " globals()['_mcdev_pp_stopped']=None",
        " globals()['_mcdev_pp_clock']=_mcdev_pp_clock",
        " globals()['_mcdev_pp_timer']=None",
        ' if _mcdev_pp_duration is not None:',
        '  def _mcdev_pp_timeout():',
        '   try:',
        "    if globals().get('_mcdev_pp_owned',False) and yappi.is_running():",
        '     yappi.stop()',
        "     globals()['_mcdev_pp_stopped']=time.time()",
        '   except: pass',
        '  _mcdev_pp_timer=threading.Timer(_mcdev_pp_duration,_mcdev_pp_timeout)',
        '  _mcdev_pp_timer.daemon=True',
        '  _mcdev_pp_timer.start()',
        "  globals()['_mcdev_pp_timer']=_mcdev_pp_timer",
        " _result={'ok':True,'running':True,'clock':_mcdev_pp_clock,'allSides':_mcdev_pp_all_sides}"
    ].join('\n');
}

/** 标记函数：在某一端的线程上跑一次，yappi 会给它记一条带该线程 ctx_id 的统计 */
export function buildPythonProfilerMarkCode(target: PythonProfilerSide): string {
    return [
        ...markerLines(target),
        '_result=True'
    ].join('\n');
}

function markerLines(target: PythonProfilerSide): string[] {
    return [
        `def _mcdev_pp_${target}_marker(): pass`,
        `_mcdev_pp_${target}_marker()`
    ];
}

/**
 * 让另一端把自己那条线程挂进**正在进行的**同一次采样。
 *
 * 不能直接调 yappi.start()：_yappi.start 发现采样已经在跑就直接返回，根本不会给当前线程
 * 装 hook。这里走 _yappi 自己的补挂路径 —— sys.setprofile 先装上 yappi 的转发器，下一次
 * profile 事件会触发 _yappi 的 _ensure_thread_profiled（仅当 start 时开了多线程），把这条
 * 线程的回调换成 yappi 的 C 回调；紧接着跑一次标记函数，用它的统计条目确认真的挂上了。
 * hooked=false 时上层立刻报错，而不是等采完才发现只有一端。
 */
export function buildPythonProfilerJoinCode(target: PythonProfilerSide): string {
    return [
        'import yappi,sys',
        'try:',
        ' import _yappi as _mcdev_pp_c',
        'except: _mcdev_pp_c=None',
        'def _mcdev_pp_side_hook(_mcdev_pp_frame,_mcdev_pp_event,_mcdev_pp_arg):',
        ' try: _mcdev_pp_c._profile_event(_mcdev_pp_frame,_mcdev_pp_event,_mcdev_pp_arg)',
        ' except: pass',
        "_mcdev_pp_reason=''",
        '_mcdev_pp_hooked=False',
        // 老版本 yappi 没有 _profile_event：干脆别装钩子，直接按「挂不上」处理
        "try: _mcdev_pp_event=getattr(_mcdev_pp_c,'_profile_event',None)",
        'except: _mcdev_pp_event=None',
        'if not yappi.is_running():',
        " _mcdev_pp_reason='not_running'",
        'elif _mcdev_pp_c is None or _mcdev_pp_event is None:',
        " _mcdev_pp_reason='no_c_module'",
        'else:',
        ' _mcdev_pp_flags=None',
        ' try:',
        '  _mcdev_pp_flags=_mcdev_pp_c._get_start_flags()',
        ' except: _mcdev_pp_flags=None',
        ' if not _mcdev_pp_flags:',
        "  _mcdev_pp_reason='no_start_flags'",
        " elif not _mcdev_pp_flags.get('profile_multithread'):",
        "  _mcdev_pp_reason='not_multithreaded'",
        ' else:',
        '  try:',
        '   sys.setprofile(_mcdev_pp_side_hook)',
        ...markerLines(target).map(line => `   ${line}`),
        "  except: _mcdev_pp_reason='setprofile_failed'",
        '  _mcdev_pp_seen=False',
        '  try:',
        '   for _mcdev_pp_stat in yappi.get_func_stats():',
        `    if (getattr(_mcdev_pp_stat,'name','') or '')=='_mcdev_pp_${target}_marker':`,
        '     _mcdev_pp_seen=True',
        '     break',
        '  except: _mcdev_pp_seen=False',
        '  if _mcdev_pp_seen:',
        '   _mcdev_pp_hooked=True',
        '  else:',
        "   _mcdev_pp_reason='marker_missing'",
        '   try: sys.setprofile(None)',
        '   except: pass',
        // 加入端绝不能碰会话状态：两端可能共用同一份 globals()（同一个解释器、同一套脚本命名空间），
        // 这里写一次 _mcdev_pp_owned=False 就会把**起采样那一端**的归属标记抹掉，
        // 采集时直接落到 not_owned，报「No MC Dev Tools Python profile is active」。
        "globals()['_mcdev_pp_joined']=True",
        "_result={'ok':True,'joined':True,'hooked':_mcdev_pp_hooked,'reason':_mcdev_pp_reason}"
    ].join('\n');
}

/**
 * 采集脚本：'all' 时一次收两端。
 *
 * 两端在同一次采样里，靠标记函数的 ctx_id 把 yappi 的统计切成 client / server 两组：
 * get_func_stats() 不带 filter 时返回进程里所有上下文的统计，按 ctx_id 过滤即得单端。
 * 某一端没挂上（标记缺失）时不抛错，只记进 missing，上层照常出另一端的分析。
 */
export function buildPythonProfilerCollectCode(target: PythonProfilerTarget): string {
    const all = target === 'all';
    return [
        'import yappi,time',
        // 归属标记丢了也要能救回来：采样确实是这次 'all' 起的（yappi 在多线程模式跑着），
        // 只是有人把命名空间里的 _mcdev_pp_owned 抹掉了（比如对端加入脚本）。
        // 这时候直接报 not_owned 等于白采一趟，宁可继续收。
        "_mcdev_pp_owned=globals().get('_mcdev_pp_owned',False)",
        'if not _mcdev_pp_owned:',
        ' try:',
        '  import _yappi as _mcdev_pp_c',
        '  _mcdev_pp_flags=_mcdev_pp_c._get_start_flags()',
        ' except: _mcdev_pp_flags=None',
        " _mcdev_pp_owned=bool(yappi.is_running() and _mcdev_pp_flags and _mcdev_pp_flags.get('profile_multithread'))",
        "if not _mcdev_pp_owned:",
        " _result={'ok':False,'reason':'not_owned','running':bool(yappi.is_running())}",
        'else:',
        " _mcdev_pp_timer=globals().get('_mcdev_pp_timer')",
        ' if _mcdev_pp_timer: _mcdev_pp_timer.cancel()',
        ' if yappi.is_running():',
        '  yappi.stop()',
        "  globals()['_mcdev_pp_stopped']=time.time()",
        ' try:',
        '  import common.minecraftMod as _mcdev_pp_mod',
        '  _mcdev_pp_instance=_mcdev_pp_mod.instance()',
        ...(all ? [
            "  _mcdev_pp_scripts_for={'client':set(_mcdev_pp_name for _mcdev_pp_name in (getattr(_mcdev_pp_instance,'clientScriptNameList',[]) or []) if _mcdev_pp_name),'server':set(_mcdev_pp_name for _mcdev_pp_name in (getattr(_mcdev_pp_instance,'serverScriptNameList',[]) or []) if _mcdev_pp_name)}",
            ' except:',
            "  _mcdev_pp_scripts_for={'client':set(),'server':set()}"
        ] : [
            `  _mcdev_pp_scripts=set(_mcdev_pp_name for _mcdev_pp_name in (getattr(_mcdev_pp_instance,'${target === 'client' ? 'clientScriptNameList' : 'serverScriptNameList'}',[]) or []) if _mcdev_pp_name)`,
            ' except: _mcdev_pp_scripts=set()'
        ]),
        ' _mcdev_pp_stats=list(yappi.get_func_stats() or ())',
        " _mcdev_pp_ctxs={}",
        ...(all ? [
            ' for _mcdev_pp_stat in _mcdev_pp_stats:',
            "  _mcdev_pp_name=getattr(_mcdev_pp_stat,'name','') or ''",
            "  if _mcdev_pp_name=='_mcdev_pp_client_marker': _mcdev_pp_ctxs['client']=int(getattr(_mcdev_pp_stat,'ctx_id',0) or 0)",
            "  elif _mcdev_pp_name=='_mcdev_pp_server_marker': _mcdev_pp_ctxs['server']=int(getattr(_mcdev_pp_stat,'ctx_id',0) or 0)",
            ' _mcdev_pp_sources=[]',
            ' _mcdev_pp_missing=[]',
            " for _mcdev_pp_side in ('client','server'):",
            '  _mcdev_pp_ctx=_mcdev_pp_ctxs.get(_mcdev_pp_side)',
            '  if _mcdev_pp_ctx is None:',
            '   _mcdev_pp_missing.append(_mcdev_pp_side)',
            '   continue',
            "  _mcdev_pp_sources.append((_mcdev_pp_side,yappi.get_func_stats({'ctx_id':_mcdev_pp_ctx}),_mcdev_pp_scripts_for.get(_mcdev_pp_side,set())))"
        ] : [
            ` _mcdev_pp_sources=[('${target}',_mcdev_pp_stats,_mcdev_pp_scripts)]`,
            ' _mcdev_pp_missing=[]'
        ]),
        ' _mcdev_pp_scripts_for={}',
        ' for _mcdev_pp_side,_mcdev_pp_stats,_mcdev_pp_names in _mcdev_pp_sources:',
        '  _mcdev_pp_scripts_for[_mcdev_pp_side]=_mcdev_pp_names',
        ' def _mcdev_pp_owner_of(_mcdev_pp_side,_mcdev_pp_module):',
        "  _mcdev_pp_parts=set(_mcdev_pp_module.replace('\\\\','/').split('/'))",
        "  _mcdev_pp_owner=''",
        '  for _mcdev_pp_name in _mcdev_pp_scripts_for.get(_mcdev_pp_side,()):',
        "   if _mcdev_pp_name in _mcdev_pp_parts or _mcdev_pp_module==_mcdev_pp_name or _mcdev_pp_module.startswith(_mcdev_pp_name+'.'):",
        '    if len(_mcdev_pp_name)>len(_mcdev_pp_owner): _mcdev_pp_owner=_mcdev_pp_name',
        '  return _mcdev_pp_owner',
        ' def _mcdev_pp_kids_of(_mcdev_pp_stat):',
        '  # yappi 顶层是 YFuncStat（有 children），子节点是 YChildFuncStat（没有 children，也没有 ctx_id）。',
        '  # 这里统一兜底，避免在子节点上取 children / ctx_id 抛 AttributeError 让整次采集失败。',
        "  try:return list(getattr(_mcdev_pp_stat,'children',()) or ())",
        '  except:return []',
        ' _mcdev_pp_all=[]',
        ' for _mcdev_pp_side,_mcdev_pp_stats,_mcdev_pp_scripts in _mcdev_pp_sources:',
        '  for _mcdev_pp_stat in _mcdev_pp_stats:',
        "   if (getattr(_mcdev_pp_stat,'name','') or '').startswith('_mcdev_pp_'): continue",
        "   _mcdev_pp_all.append((_mcdev_pp_side,_mcdev_pp_stat,_mcdev_pp_owner_of(_mcdev_pp_side,getattr(_mcdev_pp_stat,'module','') or '')))",
        ' _mcdev_pp_all.sort(key=lambda _mcdev_pp_item:_mcdev_pp_item[1].ttot,reverse=True)',
        ' _mcdev_pp_project=[_mcdev_pp_item for _mcdev_pp_item in _mcdev_pp_all if _mcdev_pp_item[2]]',
        ' # 按 (端,mod) 分组分预算：一起按 ttot 截断会让慢的端 / mod 整段消失。',
        ' _mcdev_pp_groups={}',
        ' for _mcdev_pp_item in _mcdev_pp_project:',
        '  _mcdev_pp_groups.setdefault((_mcdev_pp_item[0],_mcdev_pp_item[2]),[]).append(_mcdev_pp_item)',
        ' _mcdev_pp_keep=[]',
        ' for _mcdev_pp_group in _mcdev_pp_groups.values():',
        `  _mcdev_pp_quota=int(${MAX_FUNCTIONS}*len(_mcdev_pp_group)/max(1,len(_mcdev_pp_project)))`,
        `  if _mcdev_pp_quota<${MIN_FUNCTIONS_PER_GROUP}: _mcdev_pp_quota=${MIN_FUNCTIONS_PER_GROUP}`,
        '  _mcdev_pp_keep+=_mcdev_pp_group[:_mcdev_pp_quota]',
        ' _mcdev_pp_keep.sort(key=lambda _mcdev_pp_item:_mcdev_pp_item[1].ttot,reverse=True)',
        ` _mcdev_pp_keep=_mcdev_pp_keep[:${MAX_FUNCTIONS}]`,
        ` _mcdev_pp_keep+=[_mcdev_pp_mod for _mcdev_pp_mod in _mcdev_pp_all if not _mcdev_pp_mod[2]][:${MAX_ENGINE_FUNCTIONS}]`,
        ' _mcdev_pp_ids=dict(((_mcdev_pp_mod[0],_mcdev_pp_mod[1].index),_pos) for _pos,_mcdev_pp_mod in enumerate(_mcdev_pp_keep))',
        ' _mcdev_pp_extra=[]',
        ' for _mcdev_pp_item in _mcdev_pp_all:',
        '  _mcdev_pp_key=(_mcdev_pp_item[0],_mcdev_pp_item[1].index)',
        '  if _mcdev_pp_key in _mcdev_pp_ids: continue',
        '  for _mcdev_pp_child in _mcdev_pp_kids_of(_mcdev_pp_item[1]):',
        '   if (_mcdev_pp_item[0],_mcdev_pp_child.index) in _mcdev_pp_ids:',
        '    _mcdev_pp_ids[_mcdev_pp_key]=len(_mcdev_pp_keep)+len(_mcdev_pp_extra)',
        '    _mcdev_pp_extra.append(_mcdev_pp_item)',
        '    break',
        `  if len(_mcdev_pp_extra)>=${MAX_EXTRA_FUNCTIONS}: break`,
        ' for _mcdev_pp_item in list(_mcdev_pp_keep):',
        '  for _mcdev_pp_child in _mcdev_pp_kids_of(_mcdev_pp_item[1]):',
        '   _mcdev_pp_key=(_mcdev_pp_item[0],_mcdev_pp_child.index)',
        '   if _mcdev_pp_key in _mcdev_pp_ids: continue',
        '   _mcdev_pp_ids[_mcdev_pp_key]=len(_mcdev_pp_keep)+len(_mcdev_pp_extra)',
        "   _mcdev_pp_extra.append((_mcdev_pp_item[0],_mcdev_pp_child,_mcdev_pp_owner_of(_mcdev_pp_item[0],getattr(_mcdev_pp_child,'module','') or '')))",
        `   if len(_mcdev_pp_extra)>=${MAX_EXTRA_FUNCTIONS}: break`,
        `  if len(_mcdev_pp_extra)>=${MAX_EXTRA_FUNCTIONS}: break`,
        ' _mcdev_pp_keep+=_mcdev_pp_extra',
        ' # 条数上限只是防呆，真正卡住回包的是单帧 16 MiB：按估算字节数再收一刀（正常采集不会触发）',
        ' _mcdev_pp_truncated=len(_mcdev_pp_all)>len(_mcdev_pp_keep)',
        ' _mcdev_pp_bytes=0',
        ' _mcdev_pp_cut=len(_mcdev_pp_keep)',
        ' for _mcdev_pp_pos in range(len(_mcdev_pp_keep)):',
        '  _mcdev_pp_item=_mcdev_pp_keep[_mcdev_pp_pos]',
        "  _mcdev_pp_bytes+=len(getattr(_mcdev_pp_item[1],'module','') or '')+len(getattr(_mcdev_pp_item[1],'name','') or '')+80",
        `  if _mcdev_pp_bytes>${MAX_NODE_BYTES}:`,
        '   _mcdev_pp_cut=_mcdev_pp_pos',
        '   break',
        ' if _mcdev_pp_cut<len(_mcdev_pp_keep):',
        '  _mcdev_pp_keep=_mcdev_pp_keep[:_mcdev_pp_cut]',
        '  _mcdev_pp_truncated=True',
        ' _mcdev_pp_nodes=[]',
        ' for _mcdev_pp_pos,_mcdev_pp_item in enumerate(_mcdev_pp_keep):',
        '  _mcdev_pp_side,_mcdev_pp_stat,_mcdev_pp_entry=_mcdev_pp_item',
        // 这里的 _mcdev_pp_stat 可能是 YChildFuncStat（子节点），它没有 ctx_id/ctx_name，
        // 直接取属性会 AttributeError 让整次采集失败，因此统一用 getattr 兜底。
        "  _mcdev_pp_nodes.append([_mcdev_pp_pos,getattr(_mcdev_pp_stat,'module','') or '',int(getattr(_mcdev_pp_stat,'lineno',0) or 0),getattr(_mcdev_pp_stat,'name','') or '',int(getattr(_mcdev_pp_stat,'ncall',0) or 0),int(getattr(_mcdev_pp_stat,'nactualcall',0) or 0),float(getattr(_mcdev_pp_stat,'tsub',0) or 0),float(getattr(_mcdev_pp_stat,'ttot',0) or 0),int(getattr(_mcdev_pp_stat,'ctx_id',0) or 0),getattr(_mcdev_pp_stat,'ctx_name','') or '',_mcdev_pp_side,1 if _mcdev_pp_entry else 0,_mcdev_pp_entry])",
        ' _mcdev_pp_edges=[]',
        ' _mcdev_pp_edge_bytes=0',
        ' for _mcdev_pp_item in _mcdev_pp_keep:',
        '  _mcdev_pp_pos=_mcdev_pp_ids[(_mcdev_pp_item[0],_mcdev_pp_item[1].index)]',
        '  _mcdev_pp_kids=[_mcdev_pp_child for _mcdev_pp_child in _mcdev_pp_kids_of(_mcdev_pp_item[1]) if (_mcdev_pp_item[0],_mcdev_pp_child.index) in _mcdev_pp_ids]',
        // 子节点是 YChildFuncStat，属性一律 getattr 兜底
        "  _mcdev_pp_kids.sort(key=lambda _mcdev_pp_child:float(getattr(_mcdev_pp_child,'ttot',0) or 0),reverse=True)",
        `  for _mcdev_pp_child in _mcdev_pp_kids[:${MAX_EDGES_PER_FUNCTION}]:`,
        "   _mcdev_pp_edges.append([_mcdev_pp_pos,_mcdev_pp_ids[(_mcdev_pp_item[0],_mcdev_pp_child.index)],int(getattr(_mcdev_pp_child,'ncall',0) or 0),float(getattr(_mcdev_pp_child,'tsub',0) or 0),float(getattr(_mcdev_pp_child,'ttot',0) or 0)])",
        '  _mcdev_pp_edge_bytes=len(_mcdev_pp_edges)*45',
        `  if len(_mcdev_pp_edges)>=${MAX_CALLS} or _mcdev_pp_edge_bytes>${MAX_EDGE_BYTES}:`,
        '   _mcdev_pp_truncated=True',
        '   break',
        " _mcdev_pp_end=globals().get('_mcdev_pp_stopped') or time.time()",
        " _result={'ok':True,'clock':globals().get('_mcdev_pp_clock','CPU'),'elapsed':max(0,_mcdev_pp_end-globals().get('_mcdev_pp_started',_mcdev_pp_end)),'total':len(_mcdev_pp_all),'projectTotal':len([_mcdev_pp_mod for _mcdev_pp_mod in _mcdev_pp_all if _mcdev_pp_mod[2]]),'engineTotal':len([_mcdev_pp_mod for _mcdev_pp_mod in _mcdev_pp_all if not _mcdev_pp_mod[2]]),'truncated':_mcdev_pp_truncated,'targets':[_mcdev_pp_source[0] for _mcdev_pp_source in _mcdev_pp_sources],'missing':_mcdev_pp_missing,'nodes':_mcdev_pp_nodes,'edges':_mcdev_pp_edges}",
        ' yappi.clear_stats()',
        " globals()['_mcdev_pp_owned']=False",
        " globals()['_mcdev_pp_timer']=None",
        " globals()['_mcdev_pp_stopped']=None"
    ].join('\n');
}

export function buildPythonProfilerCleanupCode(): string {
    return [
        'import yappi,sys',
        "_mcdev_pp_timer=globals().get('_mcdev_pp_timer')",
        'if _mcdev_pp_timer: _mcdev_pp_timer.cancel()',
        "if globals().get('_mcdev_pp_owned',False):",
        ' if yappi.is_running(): yappi.stop()',
        ' yappi.clear_stats()',
        "if globals().get('_mcdev_pp_joined',False):",
        ' # 挂钩子的那一侧：采样已经停了，把本线程残留的 profile 回调摘掉',
        ' try: sys.setprofile(None)',
        ' except: pass',
        "globals()['_mcdev_pp_owned']=False",
        "globals()['_mcdev_pp_joined']=False",
        "globals()['_mcdev_pp_timer']=None",
        "globals()['_mcdev_pp_stopped']=None",
        '_result=True'
    ].join('\n');
}

export function parsePythonProfilerStart(value: unknown): void {
    const record = asRecord(value);
    if (record.ok === true) {
        return;
    }
    if (record.reason === 'busy') {
        throw new Error('Another Python profiler is already running in this target');
    }
    throw new Error('Python profiler could not be started');
}

/** 对端加入同一次采样失败时的错误：必须在开始时就知道，不能等采完才发现只有一端 */
export function parsePythonProfilerJoin(value: unknown): void {
    const record = asRecord(value);
    if (record.ok === true && record.hooked === true) {
        return;
    }
    const reason = typeof record.reason === 'string' ? record.reason : '';
    // 加入脚本总是回 ok:True 并带 reason，所以先看 reason 才能给出准确原因
    if (reason === 'not_running') {
        throw new Error('The other side could not join this profile: no Python profile is running');
    }
    if (reason === 'not_multithreaded') {
        throw new Error('The other side could not join this profile: yappi was not started in multithread mode');
    }
    if (record.ok !== true) {
        throw new Error('The other side could not join this profile');
    }
    throw new Error('The other side could not be profiled'
        + (reason ? ` (${reason})` : ''));
}

export function parsePythonProfilerResult(
    value: unknown,
    target: PythonProfilerTarget = 'client'
): PythonProfilerResult {
    const record = asRecord(value);
    if (record.ok !== true) {
        throw new Error(record.reason === 'not_owned'
            ? (record.running === true
                ? 'The Python profile is running but its ownership marker was lost'
                : 'No MC Dev Tools Python profile is active')
            : 'Python profiler did not return a result');
    }
    const clock: PythonProfilerClock = record.clock === 'WALL' ? 'WALL' : 'CPU';
    const nodes = Array.isArray(record.nodes) ? record.nodes : [];
    const edges = Array.isArray(record.edges) ? record.edges : [];
    const functions = nodes
        .slice(0, MAX_FUNCTIONS + MAX_ENGINE_FUNCTIONS + MAX_EXTRA_FUNCTIONS)
        .map(value => parseFunctionRow(value, target))
        .filter(isDefined);
    const projectCaptured = functions.filter(item => item.isProject).length;
    const functionsById = new Map(functions.map(item => [item.id, item]));
    const calls = edges.slice(0, MAX_CALLS).map(parseCallRow).filter(isDefined).filter(item => (
        functionsById.has(item.callerId)
        && functionsById.has(item.calleeId)
        && functionsById.get(item.callerId)?.target === functionsById.get(item.calleeId)?.target
    ));
    const targets = readSides(record.targets);
    const missingSides = readSides(record.missing);
    if (functions.length === 0) {
        throw new Error(missingSides.length > 0
            ? `No Python samples were captured (${missingSides.join(' and ')} never joined the profile)`
            : 'No Python samples were captured');
    }
    return {
        clock,
        elapsedSeconds: finiteNumber(record.elapsed),
        totalFunctions: Math.max(projectCaptured, finiteInteger(record.projectTotal)),
        engineFunctions: Math.max(functions.length - projectCaptured, finiteInteger(record.engineTotal)),
        truncated: record.truncated === true,
        functions,
        calls,
        mods: summarizePythonProfilerMods({ functions }),
        targets,
        missingSides
    };
}

function readSides(value: unknown): PythonProfilerSide[] {
    const items = Array.isArray(value) ? value : [];
    const sides: PythonProfilerSide[] = [];
    for (const item of items) {
        if ((item === 'client' || item === 'server') && !sides.includes(item)) {
            sides.push(item);
        }
    }
    return sides;
}

/**
 * mod 名归一化：引擎/脚本有时会把 client、common、server 之类子目录也带进来，
 * 这些其实属于同一个 mod，这里只保留根目录名，避免筛选里冒出好几条同名胶囊。
 */
export function normalizeProfilerModName(name: string): string {
    const trimmed = (name || '').trim();
    if (!trimmed) {
        return '';
    }
    const root = trimmed.replace(/\\/g, '/').split(/[./]/)[0].trim();
    return root || trimmed;
}

/** 函数归属的 mod 名；'' 表示引擎 / 原版函数（不参与 mod 筛选） */
export function profilerFunctionMod(item: PythonProfilerFunction): string {
    if (item.isProject === false) {
        return '';
    }
    const declared = (item.mod || '').trim();
    return normalizeProfilerModName(declared || guessModFromModule(item.module));
}

/**
 * 按 mod 聚合：每个 mod 的自身耗时是加和（不会重复计），
 * 总耗时只是各函数耗时之和，含嵌套重复，只用作排序参考。
 */
export function summarizePythonProfilerMods(
    result: Pick<PythonProfilerResult, 'functions'>
): PythonProfilerModSummary[] {
    const groups = new Map<string, PythonProfilerModSummary>();
    for (const item of result.functions) {
        const name = profilerFunctionMod(item);
        if (!name) {
            continue;
        }
        let summary = groups.get(name);
        if (!summary) {
            summary = { name, functions: 0, calls: 0, selfTime: 0, totalTime: 0 };
            groups.set(name, summary);
        }
        summary.functions += 1;
        summary.calls += item.calls;
        summary.selfTime += item.selfTime;
        summary.totalTime += item.totalTime;
    }
    return Array.from(groups.values()).sort((left, right) => (
        right.selfTime - left.selfTime
        || right.totalTime - left.totalTime
        || left.name.localeCompare(right.name)
    ));
}

/**
 * 抽出单个 mod 的结果子集：面板筛选、报告正文、给 Agent 的提问都走这一条路径，
 * 避免「界面看到的」和「复制出去分析的」不是同一批函数。
 */
export function filterPythonProfilerResultByMod(
    result: PythonProfilerResult,
    mod: string
): PythonProfilerResult {
    const functions = result.functions.filter(item => profilerFunctionMod(item) === mod);
    const ids = new Set(functions.map(item => item.id));
    return {
        ...result,
        totalFunctions: functions.length,
        functions,
        calls: result.calls.filter(item => ids.has(item.callerId) && ids.has(item.calleeId)),
        mods: summarizePythonProfilerMods({ functions })
    };
}

/** 旧载荷或脚本名没匹配上时，用模块路径首段兜底，至少还能分组 */
function guessModFromModule(module: string): string {
    const segments = module.replace(/\\/g, '/').split('/').filter(Boolean);
    const first = segments[0] || '';
    if (!first || /^[a-zA-Z]:$/.test(first)) {
        return '';
    }
    return first.slice(0, 256);
}

function validateDuration(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error('Profile duration must be greater than zero');
    }
    return value;
}

function parseFunctionRow(value: unknown, fallbackTarget: PythonProfilerTarget): PythonProfilerFunction | undefined {
    if (!Array.isArray(value) || value.length < 10) {
        return undefined;
    }
    const id = finiteInteger(value[0], -1);
    if (id < 0 || typeof value[1] !== 'string' || typeof value[3] !== 'string') {
        return undefined;
    }
    const rowTarget = value[10] === 'client' || value[10] === 'server' ? value[10] : undefined;
    const target = rowTarget ?? (fallbackTarget === 'all' ? undefined : fallbackTarget);
    if (!target) {
        return undefined;
    }
    return {
        id,
        target,
        module: value[1].slice(0, 4096),
        line: finiteInteger(value[2]),
        name: value[3].slice(0, 512),
        calls: finiteInteger(value[4]),
        actualCalls: finiteInteger(value[5]),
        selfTime: finiteNumber(value[6]),
        totalTime: finiteNumber(value[7]),
        contextId: finiteInteger(value[8]),
        contextName: typeof value[9] === 'string' ? value[9].slice(0, 512) : '',
        // 旧版载荷没有第 12 位标记，按 mod 函数处理，避免默认视图变空
        isProject: value.length > 11 ? Boolean(value[11]) : true,
        // 第 13 位是 mod 归属；旧载荷没有，留给 profilerFunctionMod 从模块名推断
        mod: typeof value[12] === 'string' ? value[12].slice(0, 256) : ''
    };
}

function parseCallRow(value: unknown): PythonProfilerCall | undefined {
    if (!Array.isArray(value) || value.length < 5) {
        return undefined;
    }
    const callerId = finiteInteger(value[0], -1);
    const calleeId = finiteInteger(value[1], -1);
    if (callerId < 0 || calleeId < 0) {
        return undefined;
    }
    return {
        callerId,
        calleeId,
        calls: finiteInteger(value[2]),
        selfTime: finiteNumber(value[3]),
        totalTime: finiteNumber(value[4])
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Python profiler returned an invalid payload');
    }
    return value as Record<string, unknown>;
}

function finiteInteger(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : fallback;
}

function finiteNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
