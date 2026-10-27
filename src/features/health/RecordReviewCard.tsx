import { useEffect, useId, useState } from 'react';
import { ChatCircleDotsIcon, CopyIcon, DownloadSimpleIcon } from '@phosphor-icons/react';
import { recordReviewQuestion, type RecordReview } from './recordReview';
import './record-review.css';

export function RecordReviewCard({ review, includeNotes, onIncludeNotes, onAsk }: {
  review: RecordReview;
  includeNotes: boolean;
  onIncludeNotes: (value: boolean) => void;
  onAsk?: (question: string) => void;
}) {
  const [notice, setNotice] = useState('');
  const prefix = useId();
  const empty = review.recordedDays === 0;
  useEffect(() => setNotice(''), [review.summary, review.csv]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(review.summary);
      setNotice('摘要已复制。');
    } catch { setNotice('当前浏览器无法自动复制，可展开摘要后长按或选中文字复制。'); }
  };
  const download = () => {
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([review.csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = review.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setNotice('已发起 CSV 下载；若微信内未保存，请复制摘要，或在系统浏览器中下载。');
    } catch { setNotice('下载暂不可用，可展开并复制摘要。'); }
    finally { if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
  };
  return <section className="record-review-card" aria-labelledby={`${prefix}-title`}>
    <header><h2 id={`${prefix}-title`}>带着记录继续沟通</h2><p>{review.from} — {review.to} · {review.recordedDays} 天有记录</p></header>
    <p>把当前时段的真实记录整理成摘要，也可以下载逐条数据，供自己回顾或就诊时使用。</p>
    <label className="record-review-notes"><input type="checkbox" checked={includeNotes} onChange={event => onIncludeNotes(event.target.checked)} />在摘要和导出文件中包含文字备注</label>
    <details className="record-review-preview"><summary>预览将带入问答或复制的摘要</summary><textarea aria-label="记录摘要，可选中复制" readOnly value={review.summary} rows={8} /></details>
    <div className="record-review-actions">
      {onAsk && <button type="button" className="journey-primary-button" disabled={empty} onClick={() => onAsk(recordReviewQuestion(review))}><ChatCircleDotsIcon size={17} />带摘要提问</button>}
      <button type="button" disabled={empty} onClick={() => void copy()}><CopyIcon size={17} />复制摘要</button>
      <button type="button" disabled={empty} onClick={download}><DownloadSimpleIcon size={17} />导出 CSV</button>
    </div>
    <small>{empty ? '本期还没有记录，先保存一份记录即可生成摘要。' : onAsk ? '带摘要提问会先填入对话输入框，可修改后再发送。CSV 保留本期每条记录，空白表示未填写。' : 'CSV 保留本期每条记录，空白表示未填写。'}</small>
    {notice && <p className="record-review-notice" role="status">{notice}</p>}
  </section>;
}
