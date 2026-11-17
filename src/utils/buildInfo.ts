import * as fs from 'fs';
import * as path from 'path';

const labelCache = new Map<string, string>();

const versionCache = new Map<string, string>();

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

/**
 * 只取扩展 package.json 里的版本号，用来给 Webview 资源加 ?v= 查询串，
 * 避免窗口重载后仍然命中旧的前端产物缓存。
 */
export function resolveExtensionVersion(extensionRoot: string): string {
    const cached = versionCache.get(extensionRoot);
    if (cached) {
        return cached;
    }
    let version = '0.0.0';
    try {
        const raw = fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        version = (pkg.version || '0.0.0').trim();
    } catch {
        // 打包产物缺 package.json 时退回 0.0.0，不影响加载
    }
    versionCache.set(extensionRoot, version);
    return version;
}
