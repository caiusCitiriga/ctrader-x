export class Sleep {
    static s(time: number) {
        return this.ms(time * 1000);
    }

    static ms(time: number) {
        return new Promise<void>((resolve) => {
            setTimeout(() => {
                resolve();
            }, time);
        });
    }
}
