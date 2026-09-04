export function isProjectPath(path: string): boolean {
  const segs = path.split("/");
  if (segs.length === 2 && segs[0].toLowerCase() === "projects") {
    return true;
  }
  if (segs.length === 3 && segs[0].toLowerCase() === "projects") {
    return segs[2] === segs[1] + ".md";
  }
  return false;
}

export function projectTitle(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/i, "");
}
