import axios, { AxiosResponse } from 'axios';
import { Message } from '@/type';
import { getFeatureGroups } from '@/config/features';
import { checkStableVersion } from '@/features/version-tracker';
import { QQBot } from '@/index';

export declare type ModrinthVersion = {
  success: boolean;
  latest: string;
};

export class ModrinthAPI {
  public static async getModVersion(slug: string): Promise<ModrinthVersion> {
    try {
      const res: AxiosResponse<string> = await axios.get(
        `https://api.modrinth.com/maven/maven/modrinth/${slug}/maven-metadata.xml`
      );
      const xml = res.data;

      // Parse XML to extract latest version
      const latestMatch = xml.match(/<latest>(.*?)<\/latest>/);
      if (!latestMatch || !latestMatch[1]) {
        return {
          success: false,
          latest: ''
        };
      }

      return {
        success: true,
        latest: latestMatch[1]
      };
    } catch (_) {
      return {
        success: false,
        latest: ''
      };
    }
  }

  public static checkVersion(bot: QQBot, slug: string, name: string) {
    ModrinthAPI.getModVersion(slug).then(version => {
      if (!version.success) return;
      // 稳定窗口确认后才通知，避免 CDN 缓存抖动导致重复发送
      checkStableVersion(`modrinth:${slug}`, version.latest).then(shouldNotify => {
        if (!shouldNotify) return;
        const msg: Message[] = [
          {
            type: 'text',
            data: {
              text: `${name}更新了！
· 最新版本：${version.latest}
· 下载直链：https://api.modrinth.com/maven/maven/modrinth/${slug}/${version.latest}/${slug}-${version.latest}.jar`
            }
          }
        ];
        for (const listener of getFeatureGroups('modrinth')) {
          bot.sendGroupMsg(listener, msg);
        }
      });
    });
  }
}
