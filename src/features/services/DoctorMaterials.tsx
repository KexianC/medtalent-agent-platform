import type { DoctorMaterial } from './doctorCustom';

export function DoctorMaterials({ materials }: { materials: DoctorMaterial[] }) {
  return <section className="tang-home-science" aria-label="资料库"><h2>资料库</h2>
    {materials.map(material => <article className="tang-svc-box" key={material.title}><h3>{material.title}</h3><p>{material.source}</p>{material.note && <p>{material.note}</p>}</article>)}
    <p className="tang-svc-note">题录来自前期材料和陈主任提供的资料，全文和能否展示待确认；不含病例数据。</p>
  </section>;
}
