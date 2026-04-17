import axios, { AxiosResponse } from 'axios';

export declare type ModrinthVersion = {
  success: boolean;
  latest: string;
};

export class ModrinthAPI {
  private static readonly AERONAUTICS_METADATA_URL: string =
    'https://api.modrinth.com/maven/maven/modrinth/create-aeronautics/maven-metadata.xml';

  public static async getAeronauticsVersion(): Promise<ModrinthVersion> {
    try {
      const res: AxiosResponse<string> = await axios.get(ModrinthAPI.AERONAUTICS_METADATA_URL);
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
}
