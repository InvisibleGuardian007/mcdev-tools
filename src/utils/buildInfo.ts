import * as fs from 'fs';
import * as path from 'path';

const labelCache = new Map<string, string>();

/**
 * 读取扩展自带的 package.json，生成「MC Dev Tools v0.1.38」这类构建标识。
 * 侧边栏面板里的徽标靠它显示当前运行版本，版本号高于插件市场版即可区分本地构建。
 */
export function resolveExtensionLabel(extensionRoot: string): string {
    const cached = labelCache.get(extensionRoot);
    if (cached) {
        return cached;
    }
    let label = 'MC Dev Tools';
    try {
        const raw = fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8');
        const pkg = JSON.parse(raw) as { displayName?: string; version?: string };
        const displayName = (pkg.displayName || 'MC Dev Tools').trim();
        label = pkg.version ? `${displayName} v${pkg.version}` : displayName;
    } catch {
        // 打包产物缺少 package.json 时退回默认名称，不影响功能
    }
    labelCache.set(extensionRoot, label);
    return label;
}
