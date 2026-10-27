import { createContext, useContext } from 'react';
/** Preview state is scoped by the route provider and cannot authenticate a consumer. */
export const DoctorPreviewContext = createContext(false);
export const useDoctorPreview = () => useContext(DoctorPreviewContext);
export const previewStorageSlug = (slug: string) => 'preview~' + slug;

export const DoctorTemplatePreviewContext = createContext(false);
export const useDoctorTemplatePreview = () => useContext(DoctorTemplatePreviewContext);
