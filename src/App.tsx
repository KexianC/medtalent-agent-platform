import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

const DoctorHub = lazy(() => import("./pages/DoctorHub"));
const DoctorApp = lazy(() => import("./pages/DoctorApp"));
const CitationReader = lazy(() => import("./pages/CitationReader"));
const Admin = lazy(() => import("./pages/Admin"));

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<main role="status" style={{ display: "grid", minHeight: "100dvh", placeItems: "center", color: "#2f8f65", background: "#f5f8f6", fontFamily: "sans-serif" }}>正在加载智能体平台…</main>}>
        <Routes>
          <Route path="/" element={<DoctorHub />} />
          <Route path="/d/:slug/*" element={<DoctorApp />} />
          <Route path="/references/:slug/:documentId/:chunkIndex" element={<CitationReader />} />
          <Route path="/admin/template-preview/:id/*" element={<DoctorApp templatePreview />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/preview/:slug/*" element={<DoctorApp preview />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
