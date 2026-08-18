import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

interface PendingBinding {
  code: string;
  username: string;
}

interface GitHubBindings {
  bindings: Record<string, string[]>;
  githubToQq: Record<string, string>;
  pending: Record<string, PendingBinding>;
}

interface GitHubUserProfile {
  login: string;
  bio: string | null;
}

export class GitHubBindingManager {
  private static readonly FILE = path.resolve(process.cwd(), 'configs', 'github-bind.json');
  private static readonly CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  private static bindings: GitHubBindings | undefined;

  public static async bind(qqUserId: number, username: string): Promise<{ state: 'pending' | 'bound'; code?: string }> {
    const normalizedUsername = GitHubBindingManager.normalizeUsername(username);
    const bindings = GitHubBindingManager.load();
    const qqUserIdText = String(qqUserId);

    const boundQqUserId = bindings.githubToQq[normalizedUsername.toLowerCase()];
    if (boundQqUserId && boundQqUserId !== qqUserIdText) {
      throw new Error(`GitHub 用户 ${normalizedUsername} 已被其他 QQ 用户绑定`);
    }
    if (GitHubBindingManager.hasBinding(qqUserIdText, normalizedUsername)) {
      return { state: 'bound' };
    }

    const pendingKey = `${qqUserIdText}:${normalizedUsername.toLowerCase()}`;
    const pending = bindings.pending[pendingKey];
    if (!pending) {
      const code = GitHubBindingManager.generateCode();
      bindings.pending[pendingKey] = { code, username: normalizedUsername };
      GitHubBindingManager.save();
      return { state: 'pending', code };
    }

    const profile = await GitHubBindingManager.getUserProfile(pending.username);
    if (!profile.bio?.includes(pending.code)) {
      return { state: 'pending', code: pending.code };
    }

    const boundUsernames = bindings.bindings[qqUserIdText] || [];
    const normalizedProfileUsername = profile.login.toLowerCase();
    const profileBoundQqUserId = bindings.githubToQq[normalizedProfileUsername];
    if (profileBoundQqUserId && profileBoundQqUserId !== qqUserIdText) {
      throw new Error(`GitHub 用户 ${profile.login} 已被其他 QQ 用户绑定`);
    }
    if (!boundUsernames.some(boundUsername => boundUsername.toLowerCase() === normalizedProfileUsername)) {
      boundUsernames.push(profile.login);
      bindings.bindings[qqUserIdText] = boundUsernames;
    }
    bindings.githubToQq[normalizedProfileUsername] = qqUserIdText;
    delete bindings.pending[pendingKey];
    GitHubBindingManager.save();
    return { state: 'bound' };
  }

  public static isBoundUsername(username: string): boolean {
    const normalizedUsername = username.toLowerCase();
    return Boolean(GitHubBindingManager.load().githubToQq[normalizedUsername]);
  }

  private static normalizeUsername(username: string): string {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
      throw new Error('GitHub 用户名格式无效');
    }
    return username;
  }

  private static generateCode(): string {
    let code = '';
    for (let index = 0; index < 12; index++) {
      code += GitHubBindingManager.CODE_ALPHABET[randomInt(GitHubBindingManager.CODE_ALPHABET.length)];
    }
    return code;
  }

  private static async getUserProfile(username: string): Promise<GitHubUserProfile> {
    try {
      const response = await axios.get<GitHubUserProfile>(`https://api.github.com/users/${username}`, {
        timeout: 10000,
        headers: { Accept: 'application/vnd.github+json' }
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`未找到 GitHub 用户 ${username}`);
      }
      throw new Error(`无法查询 GitHub 用户 ${username}`);
    }
  }

  private static hasBinding(qqUserId: string, username: string): boolean {
    return (GitHubBindingManager.load().bindings[qqUserId] || []).some(
      boundUsername => boundUsername.toLowerCase() === username.toLowerCase()
    );
  }

  private static load(): GitHubBindings {
    if (GitHubBindingManager.bindings) return GitHubBindingManager.bindings;

    fs.mkdirSync(path.dirname(GitHubBindingManager.FILE), { recursive: true });
    if (!fs.existsSync(GitHubBindingManager.FILE)) {
      GitHubBindingManager.bindings = { bindings: {}, githubToQq: {}, pending: {} };
      GitHubBindingManager.save();
      return GitHubBindingManager.bindings;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(GitHubBindingManager.FILE, 'utf8')) as Partial<GitHubBindings>;
      const bindings: Record<string, string[]> =
        parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {};
      const githubToQq: Record<string, string> =
        parsed.githubToQq && typeof parsed.githubToQq === 'object' ? parsed.githubToQq : {};
      let needsSave = !parsed.githubToQq;

      for (const [qqUserId, usernames] of Object.entries(bindings)) {
        if (!Array.isArray(usernames)) continue;
        for (const username of usernames) {
          if (typeof username !== 'string') continue;
          const normalizedUsername = username.toLowerCase();
          if (!githubToQq[normalizedUsername]) {
            githubToQq[normalizedUsername] = qqUserId;
            needsSave = true;
          }
        }
      }

      GitHubBindingManager.bindings = {
        bindings,
        githubToQq,
        pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {}
      };
      if (needsSave) GitHubBindingManager.save();
    } catch (error) {
      throw new Error(`无法加载 GitHub 绑定数据：${error instanceof Error ? error.message : String(error)}`);
    }

    return GitHubBindingManager.bindings;
  }

  private static save(): void {
    fs.writeFileSync(GitHubBindingManager.FILE, `${JSON.stringify(GitHubBindingManager.bindings, null, 2)}\n`, 'utf8');
  }
}
