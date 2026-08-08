/** Loads optional diagnostic monitors only on explicitly instrumented runs. */
export const tryMonitorExtras = async (): Promise<void> => {
    if (process.env.MONITOR_EXTRAS) {
        await import('./monitoring');
    }
};
