'use strict';

class Watchdog {
  constructor({ config, logger, hasStage, onStuck }) {
    this.config = config;
    this.logger = logger;
    this.hasStage = hasStage;
    this.onStuck = onStuck;
    this.lastBeat = Date.now();
    this.restarts = [];
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this._check(), 3000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    this.lastBeat = Date.now();
  }

  _check() {
    const timeout = (this.config.watchdog.heartbeatTimeoutSec || 12) * 1000;
    if (!this.hasStage()) return;
    if (Date.now() - this.lastBeat < timeout) return;

    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 3600e3);
    if (this.restarts.length >= (this.config.watchdog.maxRestartsPerHour || 6)) {
      this.logger.error('渲染层持续无响应，已达每小时重启上限，停止自动重启');
      this.lastBeat = now;
      return;
    }
    this.restarts.push(now);
    this.logger.warn('舞台页面心跳超时，正在重启渲染进程', { restartsLastHour: this.restarts.length });
    this.lastBeat = now;
    try { this.onStuck?.(); } catch (err) {
      this.logger.error(`重启舞台失败: ${err.message}`);
    }
  }

  status() {
    return {
      lastBeatAgoSec: Math.round((Date.now() - this.lastBeat) / 1000),
      restartsLastHour: this.restarts.filter((t) => Date.now() - t < 3600e3).length,
    };
  }
}

module.exports = { Watchdog };
