import React, { useState } from 'react';
import { I18nText } from '../i18n';
import type { WorldInfo } from '../types';
import { useDefaultValues } from '../hooks/useDefaultValues';
import { useExperimentDefaults, EXPERIMENT_DEFAULT_VALUES } from '../hooks/useExperimentDefaults';
import { NumberSelect } from './NumberSelect';
import { SectionHeader } from './SectionHeader';

interface McdevData {
  world_name?: string;
  world_folder_name?: string;
  /** 启动时按选中存档自动装配 MOD 目录（默认开启） */
  world_auto_mods?: boolean;
  world_seed?: number | null;
  game_mode?: number;
  world_type?: number;
  experiment_options?: {
    data_driven_biomes?: boolean;
    upcoming_creator_features?: boolean;
    experimental_creator_cameras?: boolean;
    gametest?: boolean;
    deferred_technical_preview?: boolean;
  };
}

interface Props {
  t: I18nText;
  data: McdevData;
  worlds?: WorldInfo[];
  onRefreshWorlds?: () => void;
  /** 立即按当前选中存档重写 MOD 目录列表 */
  onSyncWorldMods?: (folder: string) => void;
  onDataChange: (field: string, value: any) => void;
  onExperimentChange: (field: string, checked: boolean) => void;
  markInitialized?: (componentId: string) => void;
}


const DEFAULT_VALUES: McdevData = {
  world_name: 'MC_DEV_WORLD',
  world_folder_name: 'MC_DEV_WORLD',
  world_auto_mods: true,
  world_seed: null,
  world_type: 1,
  game_mode: 1,
};

export const WorldSettings: React.FC<Props> = ({
  t,
  data,
  worlds = [],
  onRefreshWorlds,
  onSyncWorldMods,
  onDataChange,
  onExperimentChange,
  markInitialized,
}) => {
  const [experimentExpanded, setExperimentExpanded] = useState(false);
  const [manualExpanded, setManualExpanded] = useState(false);

  const currentFolder = data.world_folder_name ?? DEFAULT_VALUES.world_folder_name ?? '';
  // 同一个文件夹只保留一条，避免选中项和列表项叠加显示
  const uniqueWorlds = React.useMemo(() => {
    const seen = new Set<string>();
    return worlds.filter((item) => {
      if (seen.has(item.folder)) {
        return false;
      }
      seen.add(item.folder);
      return true;
    });
  }, [worlds]);
  const currentWorld = uniqueWorlds.find((item) => item.folder === currentFolder);
  const formatWorldLabel = (item: WorldInfo): string => {
    const name = item.name && item.name !== item.folder ? `${item.name} — ${item.folder}` : item.folder;
    return `${name} （${item.matchedMods}${t.worldModUnit} / ${item.packs}${t.worldPackUnit}）`;
  };

  useDefaultValues(data, DEFAULT_VALUES, onDataChange, markInitialized ? () => markInitialized('WorldSettings') : undefined);
  useExperimentDefaults(data.experiment_options, onExperimentChange, markInitialized ? () => markInitialized('ExperimentOptions') : undefined);

  return (
    <div className="section">
      <SectionHeader id="world" icon="codicon-globe" title={t.worldSettings} />
      
      <div className="control-group">
        <label htmlFor="world_folder_pick">{t.worldSelect}</label>
        <div className="world-select-row">
          <select
            id="world_folder_pick"
            value={currentFolder}
            onChange={(e) => {
              const picked = uniqueWorlds.find((item) => item.folder === e.target.value);
              onDataChange('world_folder_name', e.target.value);
              if (picked) {
                onDataChange('world_name', picked.name);
              }
            }}
          >
            {!currentWorld && (
              <option value={currentFolder}>{currentFolder || '—'}</option>
            )}
            {uniqueWorlds.map((item) => (
              <option key={item.folder} value={item.folder}>
                {formatWorldLabel(item)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-link-compact world-select-refresh"
            onClick={onRefreshWorlds}
            title={t.worldSelectRefresh}
            aria-label={t.worldSelectRefresh}
          >
            <span className="codicon codicon-refresh"></span>
          </button>
        </div>
        <div className="world-select-hint">{t.worldSelectHint}</div>
        <div className="checkbox-group world-auto-mods-row">
          <input
            type="checkbox"
            id="world_auto_mods"
            checked={data.world_auto_mods !== false}
            onChange={(e) => onDataChange('world_auto_mods', e.target.checked)}
          />
          <label htmlFor="world_auto_mods">{t.worldAutoMods}</label>
          <button
            type="button"
            className="btn-link-compact world-sync-mods"
            onClick={() => onSyncWorldMods?.(currentFolder)}
            title={t.worldSyncMods}
            aria-label={t.worldSyncMods}
            disabled={!currentFolder}
          >
            <span className="codicon codicon-sync"></span>
          </button>
        </div>
        <div className="world-select-hint">{t.worldAutoModsHint}</div>
      </div>

      <div className={`subsection ${manualExpanded ? '' : 'collapsed'}`}>
        <div className="subsection-header" onClick={() => setManualExpanded(!manualExpanded)}>
          <span className="subsection-title">
            <span className="codicon codicon-chevron-right"></span>
            {t.worldManualSection}
          </span>
        </div>
        <div className="collapsible-content">
          <div className="control-group">
            <label htmlFor="world_name">{t.worldName}</label>
            <input
              type="text"
              id="world_name"
              value={data.world_name ?? DEFAULT_VALUES.world_name ?? ''}
              onChange={(e) => onDataChange('world_name', e.target.value)}
              placeholder="MC_DEV_WORLD"
            />
          </div>

          <div className="control-group">
            <label htmlFor="world_folder_name">{t.worldFolder}</label>
            <input
              type="text"
              id="world_folder_name"
              value={data.world_folder_name ?? DEFAULT_VALUES.world_folder_name ?? ''}
              onChange={(e) => onDataChange('world_folder_name', e.target.value)}
              placeholder="MC_DEV_WORLD"
            />
          </div>
        </div>
      </div>

      <div className="control-group">
        <label htmlFor="world_seed">{t.worldSeed}</label>
        <input
          type="text"
          id="world_seed"
          value={data.world_seed === null || data.world_seed === undefined ? '' : String(data.world_seed)}
          onChange={(e) => {
            const val = e.target.value.trim();
            onDataChange('world_seed', val === '' ? null : Number(val));
          }}
          placeholder={t.worldSeed}
        />
      </div>

      <div className="control-group">
        <label htmlFor="world_type">{t.worldType}</label>
        <NumberSelect
          id="world_type"
          value={data.world_type ?? DEFAULT_VALUES.world_type ?? 1}
          options={[
            { value: 1, label: t.infinity },
            { value: 2, label: t.flat },
            { value: 0, label: t.old },
          ]}
          onChange={(value) => onDataChange('world_type', value)}
        />
      </div>

      <div className="control-group">
        <label htmlFor="game_mode">{t.gameMode}</label>
        <NumberSelect
          id="game_mode"
          value={data.game_mode ?? DEFAULT_VALUES.game_mode ?? 1}
          options={[
            { value: 0, label: t.survival },
            { value: 1, label: t.creative },
            { value: 2, label: t.adventure },
            { value: 3, label: t.spectator },
          ]}
          onChange={(value) => onDataChange('game_mode', value)}
        />
      </div>

      {/* Experimental Options Subsection */}
      <div className={`subsection ${experimentExpanded ? '' : 'collapsed'}`}>
        <div className="subsection-header" onClick={() => setExperimentExpanded(!experimentExpanded)}>
          <span className="subsection-title">
            <span className="codicon codicon-chevron-right"></span>
            {t.experimentOptions}
          </span>
        </div>
        <div className="collapsible-content">
          <div className="checkbox-group">
            <input
              type="checkbox"
              id="exp_data_driven_biomes"
              checked={data.experiment_options?.data_driven_biomes ?? EXPERIMENT_DEFAULT_VALUES.data_driven_biomes}
              onChange={(e) => onExperimentChange('data_driven_biomes', e.target.checked)}
            />
            <label htmlFor="exp_data_driven_biomes">{t.dataDrivenBiomes}</label>
          </div>
          <div className="checkbox-group">
            <input
              type="checkbox"
              id="exp_upcoming_creator_features"
              checked={data.experiment_options?.upcoming_creator_features ?? EXPERIMENT_DEFAULT_VALUES.upcoming_creator_features}
              onChange={(e) => onExperimentChange('upcoming_creator_features', e.target.checked)}
            />
            <label htmlFor="exp_upcoming_creator_features">{t.upcomingCreatorFeatures}</label>
          </div>
          <div className="checkbox-group">
            <input
              type="checkbox"
              id="exp_experimental_creator_cameras"
              checked={data.experiment_options?.experimental_creator_cameras ?? EXPERIMENT_DEFAULT_VALUES.experimental_creator_cameras}
              onChange={(e) => onExperimentChange('experimental_creator_cameras', e.target.checked)}
            />
            <label htmlFor="exp_experimental_creator_cameras">{t.experimentalCreatorCameras}</label>
          </div>
          <div className="checkbox-group">
            <input
              type="checkbox"
              id="exp_gametest"
              checked={data.experiment_options?.gametest ?? EXPERIMENT_DEFAULT_VALUES.gametest}
              onChange={(e) => onExperimentChange('gametest', e.target.checked)}
            />
            <label htmlFor="exp_gametest">{t.betaApi}</label>
          </div>
          <div className="checkbox-group">
            <input
              type="checkbox"
              id="exp_deferred_technical_preview"
              checked={data.experiment_options?.deferred_technical_preview ?? EXPERIMENT_DEFAULT_VALUES.deferred_technical_preview}
              onChange={(e) => onExperimentChange('deferred_technical_preview', e.target.checked)}
            />
            <label htmlFor="exp_deferred_technical_preview">{t.deferredTechnicalPreview}</label>
          </div>
        </div>
      </div>
    </div>
  );
};
