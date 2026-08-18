import axios, { AxiosResponse } from 'axios';
import { EventDataManager } from '@/event';
import { Message } from '@/type';
import { botConfig } from '@/config';
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
      EventDataManager.getStorage(slug, 'latest').then((latest: string) => {
        // If current request succeeds but previous failed, or version changed
        if (version.success && (!latest || latest !== version.latest)) {
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
          EventDataManager.setStorage(slug, 'latest', version.latest).then();
          for (const listener of botConfig.functionModrinthGroup) {
            bot.sendGroupMsg(listener, msg);
          }
        }
        // If current request fails but we had a previous success, reset the storage
        else if (!version.success && latest) {
          EventDataManager.setStorage(slug, 'latest', '').then();
        }
        // If first time successful, just store it
        else if (version.success && !latest) {
          EventDataManager.setStorage(slug, 'latest', version.latest).then();
        }
      });
    });
  }
}
