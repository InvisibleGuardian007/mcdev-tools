import { useState } from 'react';
import { CaptureSync } from '../../WorkbenchApp';
import { I18nText } from '../../i18n';
import { HostBridgeSessionSummary } from '../../types';
import { PythonProfilerTool } from './PythonProfilerTool';
import { PythonMemoryProfilerTool } from './PythonMemoryProfilerTool';

export interface PythonCombinedToolProps {
  session?: HostBridgeSessionSummary;
  t: I18nText;
  sync?: CaptureSync;
  /** 采集由顶部操作条驱动（集成面板），工具条里不再重复放按钮 */
  topBarCapture?: boolean;
}

type CombinedView = 'profiler' | 'memory';

/**
 * Python 性能 + 内存合并页签：
 * - 两个工具都常驻挂载（只是隐藏其中一个），所以「同时采集」能一次启动两边，切回来结果也还在；
 * - 启停统一交给顶部「开始采集（性能+内存）/ 停止采集」，工具条里不再重复放按钮。
 */
export function PythonCombinedTool({ session, t, sync, topBarCapture }: PythonCombinedToolProps) {
  const [view, setView] = useState<CombinedView>('profiler');
  return (
    <div className="python-combined">
      <div className="python-combined-switch" role="tablist" aria-label={t.pythonCombinedTab}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'profiler'}
          className={view === 'profiler' ? 'active' : ''}
          onClick={() => setView('profiler')}
        >
          <span className="codicon codicon-pulse" />
          <span>{t.pythonProfilerTab}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'memory'}
          className={view === 'memory' ? 'active' : ''}
          onClick={() => setView('memory')}
        >
          <span className="codicon codicon-database" />
          <span>{t.pythonMemoryTab}</span>
        </button>
        <span className="python-combined-hint">
          <span className="codicon codicon-info" />
          <span>{t.pythonCombinedHint}</span>
        </span>
      </div>
      <div className="python-combined-pane" style={{ display: view === 'profiler' ? 'flex' : 'none' }}>
        <PythonProfilerTool session={session} t={t} sync={sync} topBarCapture={topBarCapture} />
      </div>
      <div className="python-combined-pane" style={{ display: view === 'memory' ? 'flex' : 'none' }}>
        <PythonMemoryProfilerTool session={session} t={t} sync={sync} topBarCapture={topBarCapture} />
      </div>
    </div>
  );
}
