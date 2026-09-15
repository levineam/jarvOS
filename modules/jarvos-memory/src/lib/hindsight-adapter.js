'use strict';

class HindsightAdapter {
  constructor({ apiUrl = 'http://127.0.0.1:8888', timeoutMs = 1500 } = {}) {
    this.apiUrl = String(apiUrl).replace(/\/$/, '');
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 1500;
  }

  async request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Hindsight returned HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async ping() {
    try {
      const response = await this.request('/health');
      return response?.status === 'ok' || response?.ok === true;
    } catch {
      return false;
    }
  }

  async recall(query) {
    try {
      const response = await this.request('/recall', { method: 'POST', body: { query: String(query || '') } });
      return {
        results: Array.isArray(response?.results)
          ? response.results.map((item) => typeof item === 'string' ? item : item?.text).filter(Boolean)
          : [],
        error: null,
      };
    } catch (error) {
      return { results: [], error: error.message };
    }
  }

  async reflect(query) {
    try {
      const response = await this.request('/reflect', { method: 'POST', body: { query: String(query || '') } });
      return { text: typeof response?.text === 'string' ? response.text : null, error: null };
    } catch (error) {
      return { text: null, error: error.message };
    }
  }
}

module.exports = { HindsightAdapter };
