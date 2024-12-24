export function generateProgramImageUrl(
  id: string,
  width: number = 600,
  height: number = 400,
): string {
  // Using picsum.photos with a consistent seed based on the program ID
  return `https://picsum.photos/seed/${id}/${width}/${height}`;
}
