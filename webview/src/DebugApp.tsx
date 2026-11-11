import { WorkbenchApp } from './WorkbenchApp';
import { DEBUG_TOOLS } from './tools';

function DebugApp() {
  return <WorkbenchApp tools={DEBUG_TOOLS} title={t => t.hostBridgeTitle} icon="codicon-debug-console" />;
}

export default DebugApp;
