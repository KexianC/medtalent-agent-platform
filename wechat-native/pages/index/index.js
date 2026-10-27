'use strict';
const { getRuntime } = require('../../utils/runtime');
const { doctorTopics, matchesDoctorTopic } = require('../../utils/models/catalog');
const { icon, decorateDoctor, portraitCropStyle, knowledgeFocus } = require('../../utils/presentation');

Page({
  data: {
    query: '', searchFocused: false, activeTopic: 'all', activeTopicLabel: '', doctors: [], filteredDoctors: [], loading: true, error: '', nativeBarHeight: 64,
    topics: doctorTopics.map(topic => ({ key: topic.key, label: topic.label, icon: icon(topic.key, 'hub') })),
    icons: { shield: icon('shield', 'hub'), search: icon('search', 'hubMuted'), emptySearch: icon('search', 'hub-empty'), arrow: icon('arrowRight', 'hub-link'), topicArrow: icon('arrowRight', 'hub-topics'), clear: icon('close', 'hub-search'), brain: icon('brain', 'hub') },
  },
  onLoad() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const capsule = wx.getMenuButtonBoundingClientRect && wx.getMenuButtonBoundingClientRect();
      this.setData({ nativeBarHeight: capsule ? capsule.bottom + 6 : (info.statusBarHeight || 20) + 44 });
    } catch (_) { /* Standard safe area is used when the host cannot report its capsule. */ }
    this.loadDirectory();
  },
  onPullDownRefresh() { this.loadDirectory().finally(() => wx.stopPullDownRefresh()); },
  onUnload() { this._closed = true; },
  async loadDirectory() {
    const attempt = this._attempt = (this._attempt || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      const doctors = await getRuntime().api.listDoctors();
      if (this._closed || attempt !== this._attempt) return;
      this.setData({ doctors: doctors.map(decorateDoctor), loading: false });
      this.applyFilters();
    } catch (error) {
      if (this._closed || attempt !== this._attempt) return;
      this.setData({ doctors: [], filteredDoctors: [], loading: false, error: error.message || '无法连接服务，请检查网络后重试。' });
    }
  },
  inputQuery(event) { this.setData({ query: event.detail.value }); this.applyFilters(); },
  focusSearch() { this.setData({ searchFocused: true }); },
  blurSearch() { this.setData({ searchFocused: false }); },
  clearQuery() { this.setData({ query: '', searchFocused: true }); this.applyFilters(); },
  search() { this.setData({ searchFocused: false }); wx.hideKeyboard(); wx.pageScrollTo({ selector: '#doctor-agents', duration: 250 }); },
  chooseTopic(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ activeTopic: this.data.activeTopic === key ? 'all' : key });
    this.applyFilters();
  },
  clearFilters() { this.setData({ query: '', activeTopic: 'all' }); this.applyFilters(); },
  applyFilters() {
    const query = this.data.query.trim().toLocaleLowerCase('zh-CN');
    const active = this.data.activeTopic;
    const topic = doctorTopics.find(topic => topic.key === active);
    this.setData({
      activeTopicLabel: topic ? topic.label : '',
      filteredDoctors: this.data.doctors.filter(doctor => {
        const searchable = [doctor.name, doctor.department, doctor.specialty, knowledgeFocus[doctor.slug], ...(doctor.topics || [])].join(' ').toLocaleLowerCase('zh-CN');
        return (!query || searchable.includes(query)) && matchesDoctorTopic(doctor, active);
      }),
    });
  },
  enterDoctor(event) { wx.navigateTo({ url: '/pages/doctor/index?slug=' + encodeURIComponent(event.currentTarget.dataset.slug) }); },
  portraitLoaded(event) {
    const slug = event.currentTarget.dataset.slug;
    const doctor = this.data.doctors.find(doctor => doctor.slug === slug);
    if (!doctor || !event.detail.width || !event.detail.height) return;
    const cropStyle = portraitCropStyle(doctor, event.detail.width, event.detail.height, 76, 84);
    if (cropStyle === doctor.portraitCropStyle) return;
    this.setData({ doctors: this.data.doctors.map(doctor => doctor.slug === slug ? Object.assign({}, doctor, { portraitCropStyle: cropStyle }) : doctor) });
    this.applyFilters();
  },
  portraitError(event) {
    const slug = event.currentTarget.dataset.slug;
    this.setData({ doctors: this.data.doctors.map(doctor => doctor.slug === slug ? Object.assign({}, doctor, { portraitUrl: '' }) : doctor) });
    this.applyFilters();
  },
});
