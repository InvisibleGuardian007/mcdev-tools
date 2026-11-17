import { DebugToolDefinition } from './WorkbenchApp';
import { CodeExecutionTool } from './components/debugger/CodeExecutionTool';
import { DebugFunctionsTool } from './components/debugger/DebugFunctionsTool';
import { UiDebuggerTool } from './components/debugger/UiDebuggerTool';
import { PythonProfilerTool } from './components/debugger/PythonProfilerTool';
import { PythonMemoryProfilerTool } from './components/debugger/PythonMemoryProfilerTool';
import { PythonCombinedTool } from './components/debugger/PythonCombinedTool';
import { NativeProfilerTool } from './components/debugger/NativeProfilerTool';
import { PerfMonitorTool } from './components/debugger/PerfMonitorTool';
import { DebugSwitchesTool } from './components/debugger/DebugSwitchesTool';

/** 所有页签的唯一来源，DebugApp（原版全量）与 StudioApp（自用排版）都从这里取，避免重复定义 */

export const codeExecutionTool: DebugToolDefinition = {
  id: 'code-execution',
  icon: 'codicon-code',
  label: t => t.hostBridgeCodeTab,
  render: ({ session, t }) => <CodeExecutionTool session={session} t={t} />,
};

export const debugFunctionsTool: DebugToolDefinition = {
  id: 'debug-functions',
  icon: 'codicon-symbol-function',
  label: t => t.debugFunctionsTab,
  render: ({ session, t }) => <DebugFunctionsTool session={session} t={t} />,
};

export const uiDebuggerTool: DebugToolDefinition = {
  id: 'ui-debugger',
  icon: 'codicon-inspect',
  label: t => t.uiDebuggerTab,
  render: ({ session, t }) => <UiDebuggerTool session={session} t={t} />,
};

export const pythonPairTool: DebugToolDefinition = {
  id: 'python-pair',
  icon: 'codicon-pulse',
  label: t => t.pythonCombinedTab,
  render: ({ session, t, sync, topBarCapture }) => (
    <PythonCombinedTool session={session} t={t} sync={sync} topBarCapture={topBarCapture} />
  ),
};

export const pythonProfilerTool: DebugToolDefinition = {
  id: 'python-profiler',
  icon: 'codicon-pulse',
  label: t => t.pythonProfilerTab,
  render: ({ session, t, sync, topBarCapture }) => (
    <PythonProfilerTool session={session} t={t} sync={sync} topBarCapture={topBarCapture} />
  ),
};

export const pythonMemoryTool: DebugToolDefinition = {
  id: 'python-memory',
  icon: 'codicon-database',
  label: t => t.pythonMemoryTab,
  render: ({ session, t, sync, topBarCapture }) => (
    <PythonMemoryProfilerTool session={session} t={t} sync={sync} topBarCapture={topBarCapture} />
  ),
};

export const nativeProfilerTool: DebugToolDefinition = {
  id: 'native-profiler',
  icon: 'codicon-dashboard',
  label: t => t.nativeProfilerTab,
  render: ({ session, t }) => <NativeProfilerTool session={session} t={t} />,
};

export const perfMonitorTool: DebugToolDefinition = {
  id: 'perf-monitor',
  icon: 'codicon-graph',
  label: t => t.perfMonitorTab,
  render: ({ session, t }) => <PerfMonitorTool session={session} t={t} />,
};

export const debugSwitchesTool: DebugToolDefinition = {
  id: 'debug-switches',
  icon: 'codicon-symbol-boolean',
  label: t => t.debugSwitchesTab,
  render: ({ session, t }) => <DebugSwitchesTool session={session} t={t} />,
};

/** 原版全量面板 */
export const DEBUG_TOOLS: DebugToolDefinition[] = [
  codeExecutionTool,
  debugFunctionsTool,
  uiDebuggerTool,
  debugSwitchesTool,
  pythonProfilerTool,
  pythonMemoryTool,
  nativeProfilerTool,
  perfMonitorTool,
];

/** 自用面板：Python 性能+内存 合并排第一，其余按需排后 */
export const STUDIO_TOOLS: DebugToolDefinition[] = [
  pythonPairTool,
  perfMonitorTool,
  debugSwitchesTool,
  uiDebuggerTool,
  nativeProfilerTool,
  codeExecutionTool,
  debugFunctionsTool,
];
