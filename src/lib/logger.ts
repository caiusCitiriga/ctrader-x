import { Config } from './config';

export class Logger {
    static debug(message: string) {
        if (Config.DEBUG_LOGS) console.log(`🐛 ${message}`);
    }

    static log(message: string) {
        console.log(`ℹ️ ${message}`);
    }

    static error(message: string) {
        console.log(`❌ ${message}`);
    }

    static warn(message: string) {
        console.log(`⚠️ ${message}`);
    }
}
