import React from 'react';
import { vscode } from '../vscode';

interface Props {
  /** 出问题的工具 id，用来区分是哪个页签崩的 */
  name: string;
  children: React.ReactNode;
}

interface State {
  error?: Error;
  componentStack?: string;
}

/**
 * 工具页签的错误边界：任何一个工具的渲染异常都不该把整个面板变成一片空白。
 * 这里既兜住 UI（显示错误文本，用户能直接截图），也把错误回传给宿主写日志。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const componentStack = info?.componentStack ?? '';
    this.setState({ componentStack });
    reportWebviewError('react-boundary:' + this.props.name, error, componentStack);
  }

  render(): React.ReactNode {
    const { error, componentStack } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <div className="debug-tool-error" role="alert">
        <h2>
          <span className="codicon codicon-error" aria-hidden="true" />
          {' '}面板渲染出错（' + this.props.name + '）
        </h2>
        <pre>{String(error.stack || error.message || error)}</pre>
        {componentStack ? <pre>{componentStack}</pre> : null}
      </div>
    );
  }
}

/** 把前端异常回传给宿主：宿主会写进日志，排查不用再靠猜 */
export function reportWebviewError(source: string, error: unknown, extra?: string): void {
  const value = error as Error | undefined;
  try {
    vscode.postMessage({
      type: 'webviewError',
      source,
      message: String(value?.message ?? error ?? ''),
      stack: String(value?.stack ?? ''),
      componentStack: extra ?? '',
    });
  } catch {
    // 连 postMessage 都不可用时只能放弃
  }
}
