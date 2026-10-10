export interface BuildingPhoto {
  url: string;
  pageUrl: string;
  title: string;
  author: string;
  license: string;
  licenseUrl: string;
}

export function validBuildingPhoto(value: unknown): value is BuildingPhoto {
  if (!value || typeof value !== "object") return false;
  const photo = value as BuildingPhoto;
  return [photo.url, photo.pageUrl, photo.title, photo.author, photo.license, photo.licenseUrl]
    .every(field => typeof field === "string" && field.trim().length > 0 && field.length <= 2000)
    && /^https:\/\/(upload|thumb)\.wikimedia\.org\/wikipedia\/commons\//.test(photo.url)
    && /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(photo.pageUrl)
    && /^https:\/\/creativecommons\.org\/(licenses\/(by|by-sa)\/[\d.]+\/?|publicdomain\/(zero|mark)\/1\.0\/?)$/.test(photo.licenseUrl);
}
