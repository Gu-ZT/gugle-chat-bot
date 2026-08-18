import * as fs from 'node:fs';

export class EventDataManager {
  private static readonly FILE: string = './configs/event-data.json';
  private static readonly LEGACY_FILE: string = './config/event-data.json';
  private static readonly LEGACY_DIRECTORY: string = './config';
  private static listeners: {
    [key: string]: { roomId: string; channelId: string }[];
  } = {};

  private static storage: {
    [key: string]: {
      [key: string]: any;
    };
  } = {};

  static {
    EventDataManager.load().then();
  }

  public static async addListener(event: string, roomId: string, channelId: string): Promise<void> {
    if (!EventDataManager.listeners[event]) EventDataManager.listeners[event] = [];
    EventDataManager.listeners[event].push({ roomId, channelId });
    await EventDataManager.save();
  }

  public static async containListener(event: string, roomId: string, channelId: string): Promise<boolean> {
    if (!EventDataManager.listeners[event]) return false;
    return EventDataManager.listeners[event].some(
      listener => listener.roomId === roomId && listener.channelId === channelId
    );
  }

  public static async removeListener(event: string, roomId: string, channelId: string): Promise<void> {
    if (!EventDataManager.listeners[event]) return;
    EventDataManager.listeners[event] = EventDataManager.listeners[event].filter(
      listener => listener.roomId !== roomId && listener.channelId !== channelId
    );
    await EventDataManager.save();
  }

  public static async getListeners(event: string): Promise<{ roomId: string; channelId: string }[]> {
    return EventDataManager.listeners[event] || [];
  }

  public static async setStorage(event: string, key: string, value: any): Promise<void> {
    if (!EventDataManager.storage[event]) EventDataManager.storage[event] = {};
    EventDataManager.storage[event][key] = value;
    await EventDataManager.save();
  }

  public static async getStorage(event: string, key: string): Promise<any> {
    if (!EventDataManager.storage[event]) return undefined;
    return EventDataManager.storage[event][key];
  }

  public static async clearStorage(event: string): Promise<void> {
    delete EventDataManager.storage[event];
    await EventDataManager.save();
  }

  private static migrateLegacyFile(): void {
    if (!fs.existsSync(EventDataManager.LEGACY_DIRECTORY)) return;

    fs.mkdirSync('./configs', { recursive: true });
    if (fs.existsSync(EventDataManager.LEGACY_FILE) && !fs.existsSync(EventDataManager.FILE)) {
      fs.renameSync(EventDataManager.LEGACY_FILE, EventDataManager.FILE);
    }
    fs.rmSync(EventDataManager.LEGACY_DIRECTORY, { recursive: true, force: true });
  }

  public static async checkAndCreateFile(): Promise<void> {
    EventDataManager.migrateLegacyFile();
    if (!fs.existsSync(EventDataManager.FILE)) {
      fs.mkdirSync('./configs', { recursive: true });
      fs.writeFile(
        EventDataManager.FILE,
        JSON.stringify(
          {
            listeners: {},
            storage: {}
          },
          null,
          4
        ),
        err => {
          if (err) Promise.reject(err);
          else Promise.resolve();
        }
      );
    }
  }

  public static async load(): Promise<void> {
    await EventDataManager.checkAndCreateFile();
    return new Promise((resolve, reject) => {
      fs.readFile(EventDataManager.FILE, (err, data) => {
        if (err) {
          EventDataManager.listeners = {};
          EventDataManager.storage = {};
          reject(err);
        } else {
          try {
            const json = JSON.parse(data.toString());
            EventDataManager.listeners = {
              ...EventDataManager.listeners,
              ...json.listeners
            };
            EventDataManager.storage = {
              ...EventDataManager.storage,
              ...json.storage
            };
            resolve();
          } catch (_) {
            this.save();
          }
        }
      });
    });
  }

  public static async save(): Promise<void> {
    await EventDataManager.checkAndCreateFile();
    const data = JSON.stringify(
      {
        listeners: EventDataManager.listeners,
        storage: EventDataManager.storage
      },
      null,
      4
    );
    return new Promise((resolve, reject) => {
      fs.writeFile(EventDataManager.FILE, data, err => {
        if (!err) resolve();
        else reject(err);
      });
    });
  }
}
