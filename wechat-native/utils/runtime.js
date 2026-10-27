const config = require('../config.js');
const { createApi } = require('./api.js');
const { createConsumerDataStore } = require('./consumer-data.js');
const { createSession } = require('./session.js');
const { createData } = require('./data.js');
const { createChat } = require('./chat.js');
const { createSpeech } = require('./speech.js');
function createStorage(wx) {
  return {
    getItem(key) { const value = wx.getStorageSync(key); return value === '' || value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value); },
    setItem(key, value) { wx.setStorageSync(key, value); },
    removeItem(key) { wx.removeStorageSync(key); },
    listKeys() { const info = wx.getStorageInfoSync(); if (!info || !Array.isArray(info.keys)) throw new Error('无法读取本机存储列表。'); return info.keys.slice(); }
  };
}
function createRuntime(options = {}) {
  const host = options.wx || wx;
  const storage = options.storage || createStorage(host);
  const api = createApi({ wx: host, storage, origin: options.origin || config.apiOrigin });
  const cloud = createConsumerDataStore({ storage, fetchImpl: api.fetchImpl });
  const session = createSession({ api, wx: host, cloud });
  const data = createData({ storage, cloud, session });
  const chat = createChat({ api, wx: host });
  const speech = createSpeech({ api, wx: host });
  let disposed = false;
  return {
    api, session, data, chat, speech,
    readScope: (slug, section, fallback) => data.get(slug, section, fallback).value,
    writeScope: data.set,
    subscribe: data.subscribe,
    storageNotice: (slug, section) => data.get(slug, section, null).error || '',
    dispose() { if (disposed) return; disposed = true; speech.dispose(); chat.dispose(); session.dispose(); data.dispose(); cloud.setIdentity(null); api.dispose(); }
  };
}
let singleton;
function getRuntime() { if (!singleton) singleton = createRuntime(); return singleton; }
module.exports = { createRuntime, getRuntime, createStorage };
