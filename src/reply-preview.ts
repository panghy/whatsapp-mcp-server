/** Keep the UTF-16 budget without cutting a valid surrogate pair in half. */
export function truncateReplyPreview(text: string, maxLength: number): string {
  let end = Math.min(text.length, maxLength)
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
    end--
  }
  return text.substring(0, end)
}
