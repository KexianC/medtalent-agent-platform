Component({
  properties: { title: String, description: String, variant: { type: String, value: 'tang' }, accentColor: { type: String, value: '#246D50' }, questions: { type: Array, value: [] }, scoredItems: { type: Number, value: -1 }, supportIndex: { type: Number, value: -1 }, supportText: { type: String, value: '' } },
  data: { answers: [], index: 0, question: null, answered: 0, choice: null, error: '', support: false, questionDescription: '' },
  observers: { questions(questions) { this.submitted = false; this.setData({ answers: questions.map(() => null), index: 0, question: questions[0] || null, answered: 0, choice: null, error: '', support: false }); this.describe(); }, 'variant, scoredItems, description'() { this.describe(); } },
  methods: {
    describe() { const { variant, scoredItems, index, description } = this.data; this.setData({ questionDescription: variant === 'tang' && scoredItems >= 0 ? index < scoredItems ? '回顾过去 2 周（14 天），按每种感受出现的频率选择最符合你的选项；不只看今天或最严重的一天。每题选一项。' : '生活影响补充题：选择这些感受对工作、家务和人际相处造成的困难程度。本题不计入总分。' : description }); },
    choose(event) { const value = Number(event.currentTarget.dataset.value), answers = [...this.data.answers]; answers[this.data.index] = value; this.setData({ answers, choice: value, answered: answers.filter(v => v !== null).length, error: '', support: this.data.supportIndex >= 0 && Number(answers[this.data.supportIndex]) > 0 }); },
    previous() { if (this.data.index > 0) this.move(this.data.index - 1); },
    move(index) { this.setData({ index, question: this.data.questions[index], choice: this.data.answers[index], error: '' }); this.describe(); },
    next() {
      if (this.data.answers[this.data.index] === null) { this.setData({ error: '请先选择本题的答案。' }); return; }
      if (this.data.index < this.data.questions.length - 1) { this.move(this.data.index + 1); return; }
      const missing = this.data.answers.findIndex(v => v === null);
      if (missing >= 0) { this.move(missing); this.setData({ error: '还有问题未作答，请补充后查看结果。' }); return; }
      if (this.submitted) return; this.submitted = true;
      this.triggerEvent('complete', { answers: this.data.answers });
    },
    close() { this.triggerEvent('close'); },
  },
});
