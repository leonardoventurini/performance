import { EventEmitter } from 'node:events';
import { AHCapture } from './ah';

function isNode () {
  return typeof process !== 'undefined' && process.versions && process.versions.node;
}

function polyfillNow () {
  const [seconds, nanoseconds] = process.hrtime();

  return seconds * 1000 + nanoseconds / 1000000;
}

export class EventLoopMonitor extends EventEmitter {
  private readonly timeoutMillis: number;
  private _stopped = true;
  private _startTime: number | null = null;
  private _lastWatchTime: number | null = null;
  private _totalLag = 0;
  private _now: () => number = Date.now;

  constructor (timeoutMillis: number) {
    super();
    this.timeoutMillis = timeoutMillis;
    this._watchLag = this._watchLag.bind(this);
    this._stopped = true;
    this._startTime = null;
    this._totalLag = 0;

    this._registerNowFunc();
  }

  start (): void {
    this._stopped = false;
    this._lastWatchTime = null;
    this._startTime = Date.now();
    this._totalLag = 0;

    this.on('lag', this._watchLag);
    this._detectLag();
  }

  stop (): void {
    this._stopped = true;
    this.removeAllListeners('lag');
  }

  status (): { pctBlock: number; elapsedTime: number; totalLag: number } {
    let pctBlock = 0;
    let elapsedTime = 0;
    if (!this._stopped && this._lastWatchTime && this._startTime) {
      elapsedTime = this._lastWatchTime - this._startTime;
      pctBlock = (this._totalLag / elapsedTime) * 100;
    }

    const statusObject = {
      pctBlock,
      elapsedTime,
      totalLag: this._totalLag
    };

    this._startTime = this._lastWatchTime;
    this._totalLag = 0;

    return statusObject;
  }

  private _watchLag (lag: number): void {
    this._lastWatchTime = Date.now();
    this._totalLag += lag;
  }

  private _detectLag (): void {
    const self = this;
    const start = self._now();

    setTimeout(function () {
      const end = self._now();
      const elapsedTime = end - start;
      const realDiff = elapsedTime - self.timeoutMillis;
      const lag = Math.max(0, realDiff);


      if (lag >= 100) {
        AHCapture.active = true;
      } else {
        AHCapture.active = false;
      }
      
      console.log('lag', lag, AHCapture.active);

      if (!self._stopped) {
        self.emit('lag', lag);
        self._detectLag();
      }
    }, self.timeoutMillis);
  }

  private _registerNowFunc (): void {
    if (isNode()) {
      const [major] = process.versions.node.split('.').map(Number);

      if ((major ?? 0) < 8) {
        this._now = polyfillNow;
        return;
      }

      const {
        performance
        // eslint-disable-next-line global-require
      } = require('perf_hooks');
      this._now = performance.now.bind(performance);
      return;
    }

    this._now = Date.now;
  }
}
