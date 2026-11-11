import React, { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_PREFIX = 'mcdev.section.';

function readCollapsed(id: string): boolean {
  try {
    return localStorage.getItem(STORAGE_PREFIX + id) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(id: string, collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + id, collapsed ? '1' : '0');
  } catch {
    // 隐私模式下 localStorage 可能不可用，折叠状态就只在本次会话内有效
  }
}

/**
 * 给折叠区块的容器加上 is-collapsed，由 CSS 隐藏除标题外的所有子元素。
 * 手动改 class 不会和 React 冲突：组件的 className 是常量字符串，React 不会重写它。
 */
function applyCollapsed(header: HTMLElement | null, collapsed: boolean): void {
  const section = header?.closest('.section');
  if (section) {
    section.classList.toggle('is-collapsed', collapsed);
  }
}

interface Props {
  /** 折叠状态的持久化键，例如 'world' / 'startup' */
  id: string;
  /** codicon 名称，例如 'codicon-globe' */
  icon: string;
  title: React.ReactNode;
  /** 标题右侧的附加操作（按钮、计数等），点击不会触发折叠 */
  children?: React.ReactNode;
}

export const SectionHeader: React.FC<Props> = ({ id, icon, title, children }) => {
  const headerRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(id));

  useEffect(() => {
    applyCollapsed(headerRef.current, collapsed);
  }, [collapsed, id]);

  const toggle = useCallback(() => {
    setCollapsed(current => {
      const next = !current;
      writeCollapsed(id, next);
      return next;
    });
  }, [id]);

  return (
    <div
      ref={headerRef}
      className="section-header-plain section-header-toggle"
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      }}
    >
      <span className="section-title">
        <span className="codicon codicon-chevron-right section-chevron" aria-hidden="true"></span>
        <span className={`codicon ${icon}`} aria-hidden="true"></span>
        {title}
      </span>
      {children ? (
        <span className="section-header-actions" onClick={(event) => event.stopPropagation()}>
          {children}
        </span>
      ) : null}
    </div>
  );
};
