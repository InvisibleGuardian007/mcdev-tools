import React, { useEffect, useMemo, useState } from 'react';
import { I18nText } from '../i18n';
import { vscode } from '../vscode';
import { useNestedDefaultValues } from '../hooks/useDefaultValues';
import { SectionHeader } from './SectionHeader';

interface McpServerConfigData {
  enabled?: boolean;
  server_ip?: string;
  server_port?: number;
}

interface Props {
  t: I18nText;
  mcpServerConfig?: McpServerConfigData;
  onMcpServerConfigChange: (field: string, value: any) => void;
  markInitialized?: (componentId: string) => void;
}

const DEFAULT_VALUES: McpServerConfigData = {
  enabled: false,
  server_ip: 'localhost',
  server_port: 19133,
};

const MCP_BRIDGE_URL = 'https://github.com/GitHub-Zero123/MCDevTool/tree/main/tools/mcdk_stdio_bridge';
const SERVER_NAME = 'minecraft';

type ProbeStatus = 'idle' | 'probing' | 'ok' | 'fail';

interface ProbeState {
  status: ProbeStatus;
  tools: string[];
  error?: string;
}

function shortenPath(full: string): string {
  if (!full) return '';
  const index = full.lastIndexOf('.vscode');
  if (index >= 0) return full.slice(index).replace(/\\/g, '/');
  return full.split(/[\\/]/).pop() || full;
}

export const McpServerConfig: React.FC<Props> = ({
  t,
  mcpServerConfig,
  onMcpServerConfigChange,
  markInitialized,
}) => {
  useNestedDefaultValues(
    mcpServerConfig,
    DEFAULT_VALUES,
    onMcpServerConfigChange,
    markInitialized ? () => markInitialized('McpServerConfig') : undefined
  );

  const enabled = mcpServerConfig?.enabled ?? DEFAULT_VALUES.enabled;
  const endpoint = useMemo(() => {
    const host = (mcpServerConfig?.server_ip ?? DEFAULT_VALUES.server_ip).trim() || 'localhost';
    const rawPort = Number(mcpServerConfig?.server_port ?? DEFAULT_VALUES.server_port);
    const port = Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535 ? Math.trunc(rawPort) : DEFAULT_VALUES.server_port;
    return `http://${host}:${port}/mcp`;
  }, [mcpServerConfig?.server_ip, mcpServerConfig?.server_port]);

  const [probe, setProbe] = useState<ProbeState>({ status: 'idle', tools: [] });
  const [notice, setNotice] = useState<string>('');

  useEffect(() => {
    setProbe({ status: 'idle', tools: [] });
  }, [endpoint]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'mcpProbeResult') {
        const tools = Array.isArray(msg.tools)
          ? msg.tools.map((item: any) => (item && typeof item.name === 'string' ? item.name : '')).filter((name: string) => !!name)
          : [];
        setProbe({ status: msg.ok ? 'ok' : 'fail', tools, error: typeof msg.error === 'string' ? msg.error : undefined });
      } else if (msg?.type === 'mcpConfigWritten') {
        if (msg.ok) {
          setNotice(t.mcpAgentWritten.replace('{path}', shortenPath(String(msg.path || ''))));
        } else {
          const reason = msg.error === 'invalidJson' ? t.mcpAgentInvalidJson : msg.error === 'noWorkspace' ? t.mcpAgentNoWorkspace : String(msg.error);
          setNotice(t.mcpAgentWriteFailed.replace('{error}', reason));
        }
      } else if (msg?.type === 'copied') {
        setNotice(msg.ok ? t.mcpAgentCopied : t.mcpAgentCopyFailed);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [t]);

  const handleOpenBridgeTool = () => {
    vscode.postMessage({ type: 'openExternal', url: MCP_BRIDGE_URL });
  };

  const handlePortChange = (value: string) => {
    const port = Number.parseInt(value, 10);
    onMcpServerConfigChange('server_port', Number.isNaN(port) ? DEFAULT_VALUES.server_port : port);
  };

  const probeServer = () => {
    setNotice('');
    setProbe({ status: 'probing', tools: [] });
    vscode.postMessage({ type: 'probeMcp', host: mcpServerConfig?.server_ip, port: mcpServerConfig?.server_port });
  };

  const copyText = (text: string) => {
    setNotice('');
    vscode.postMessage({ type: 'copyText', text });
  };

  const copyAgentBrief = () => {
    setNotice('');
    vscode.postMessage({ type: 'copyAgentBrief', url: endpoint, tools: probe.tools });
  };

  const writeMcpJson = () => {
    setNotice('');
    vscode.postMessage({ type: 'writeVscodeMcp', url: endpoint });
  };

  const claudeCommand = `claude mcp add --transport http ${SERVER_NAME} ${endpoint}`;
  const mcpJson = `${JSON.stringify({ servers: { [SERVER_NAME]: { type: 'http', url: endpoint } } }, null, 2)}\n`;

  const statusText = !enabled
    ? t.mcpAgentStatusDisabled
    : probe.status === 'probing'
      ? t.mcpAgentProbing
      : probe.status === 'ok'
        ? t.mcpAgentStatusOk.replace('{count}', String(probe.tools.length))
        : probe.status === 'fail'
          ? t.mcpAgentStatusFail.replace('{error}', probe.error || '?')
          : t.mcpAgentStatusIdle;

  return (
    <div className="section">
      <SectionHeader id="mcp" icon="codicon-server" title={t.mcpServerConfig}>
        <button
          type="button"
          className="btn-link-compact mcp-bridge-btn"
          onClick={handleOpenBridgeTool}
          title={t.getMcpBridgeTool}
        >
          <span className="codicon codicon-link-external"></span>
          {t.getMcpBridgeTool}
        </button>
      </SectionHeader>

      <div className="section-description">
        {t.mcpServerDescription}
      </div>

      <div className="checkbox-group">
        <input
          type="checkbox"
          id="mcp_server_enabled"
          checked={enabled}
          onChange={(e) => onMcpServerConfigChange('enabled', e.target.checked)}
        />
        <label htmlFor="mcp_server_enabled">{t.mcpServerEnabled}</label>
      </div>

      <div className="mcp-config-grid">
        <div className="control-group">
          <label htmlFor="mcp_server_ip">{t.mcpServerIp}</label>
          <input
            type="text"
            id="mcp_server_ip"
            value={mcpServerConfig?.server_ip ?? DEFAULT_VALUES.server_ip}
            onChange={(e) => onMcpServerConfigChange('server_ip', e.target.value)}
            placeholder="localhost"
          />
        </div>

        <div className="control-group">
          <label htmlFor="mcp_server_port">{t.mcpServerPort}</label>
          <input
            type="number"
            id="mcp_server_port"
            min={1}
            max={65535}
            value={mcpServerConfig?.server_port ?? DEFAULT_VALUES.server_port}
            onChange={(e) => handlePortChange(e.target.value)}
            placeholder="19133"
          />
        </div>
      </div>

      <div className="mcp-agent">
        <div className="mcp-endpoint-row">
          <code className="mcp-endpoint-url" title={endpoint}>{endpoint}</code>
          <button
            type="button"
            className="mcp-agent-btn"
            onClick={probeServer}
            disabled={probe.status === 'probing'}
          >
            <span className="codicon codicon-plug"></span>
            {probe.status === 'probing' ? t.mcpAgentProbing : t.mcpAgentProbe}
          </button>
        </div>

        <div
          className={
            'mcp-status' +
            (probe.status === 'ok' ? ' is-ok' : probe.status === 'fail' || !enabled ? ' is-warn' : '')
          }
        >
          {statusText}
        </div>

        {probe.status === 'ok' && probe.tools.length > 0 && (
          <div className="mcp-tool-list">
            {probe.tools.map((name) => (
              <span className="mcp-tool-chip" key={name}>{name}</span>
            ))}
          </div>
        )}

        <div className="mcp-agent-btn-row">
          <button type="button" className="mcp-agent-btn" onClick={copyAgentBrief}>
            <span className="codicon codicon-copy"></span>
            {t.mcpAgentCopyBrief}
          </button>
          <button type="button" className="mcp-agent-btn" onClick={() => copyText(claudeCommand)}>
            <span className="codicon codicon-terminal"></span>
            {t.mcpAgentCopyClaude}
          </button>
          <button type="button" className="mcp-agent-btn" onClick={() => copyText(mcpJson)}>
            <span className="codicon codicon-json"></span>
            {t.mcpAgentCopyJson}
          </button>
          <button type="button" className="mcp-agent-btn" onClick={writeMcpJson}>
            <span className="codicon codicon-file-add"></span>
            {t.mcpAgentWriteJson}
          </button>
        </div>

        {notice && <div className="mcp-notice">{notice}</div>}
        <div className="mcp-agent-hint">{t.mcpAgentRestartHint}</div>
      </div>
    </div>
  );
};
