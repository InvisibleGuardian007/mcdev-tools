import { I18nText } from '../../i18n';

export interface DebugSwitchMeta {
  /** 与宿主 src/hostBridge/debugSwitches.ts 的 id 保持一致 */
  id: string;
  optionKey: string;
  label: (t: I18nText) => string;
  shortLabel: (t: I18nText) => string;
}

export const DEBUG_SWITCHES_UI: DebugSwitchMeta[] = [
  {
    id: 'bounds',
    optionKey: 'dev_renderBoundingBox',
    label: t => t.debugSwitchBounds,
    shortLabel: t => t.debugSwitchShortBounds,
  },
  {
    id: 'findMobs',
    optionKey: 'dev_findMobs',
    label: t => t.debugSwitchFindMobs,
    shortLabel: t => t.debugSwitchShortFindMobs,
  },
  {
    id: 'paths',
    optionKey: 'dev_renderPaths',
    label: t => t.debugSwitchPaths,
    shortLabel: t => t.debugSwitchShortPaths,
  },
  {
    id: 'goalState',
    optionKey: 'dev_renderGoalState',
    label: t => t.debugSwitchGoalState,
    shortLabel: t => t.debugSwitchShortGoalState,
  },
  {
    id: 'mobInfo',
    optionKey: 'dev_renderMobInfoState',
    label: t => t.debugSwitchMobInfo,
    shortLabel: t => t.debugSwitchShortMobInfo,
  },
  {
    id: 'chunkMap',
    optionKey: 'dev_showchunkmap',
    label: t => t.debugSwitchChunkMap,
    shortLabel: t => t.debugSwitchShortChunkMap,
  },
  {
    id: 'disableTerrain',
    optionKey: 'dev_disable_render_terrain',
    label: t => t.debugSwitchDisableTerrain,
    shortLabel: t => t.debugSwitchShortDisableTerrain,
  },
];

export function describeDebugSwitchError(
  code: string | undefined,
  detail: string | undefined,
  t: I18nText,
): string {
  let message: string;
  switch (code) {
    case 'debug-ui-unavailable':
      message = t.debugSwitchesErrorUiUnavailable;
      break;
    case 'settings-closed':
    case 'settings-unavailable':
      message = t.debugSwitchesErrorSettings;
      break;
    case 'settings-layout-unknown':
      message = t.debugSwitchesErrorSettingsLayout;
      break;
    case 'settings-open-failed':
      message = t.debugSwitchesErrorOpenFailed;
      break;
    case 'switch-not-found':
      message = t.debugSwitchesErrorSwitchNotFound;
      break;
    case 'option-rejected':
      message = t.debugSwitchesErrorOption;
      break;
    case 'ui-rejected':
      message = t.debugSwitchesErrorUi;
      break;
    case 'debug-channel-unavailable':
      message = t.debugSwitchesErrorChannel;
      break;
    default:
      message = t.debugSwitchesErrorGeneric;
      break;
  }
  return detail ? `${message} (${detail})` : message;
}
