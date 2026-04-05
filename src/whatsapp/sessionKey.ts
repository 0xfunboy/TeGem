export function getWhatsappSessionKey(chatId: string, senderId: string, isGroup: boolean): string {
  if (!isGroup) return `wa_user_${senderId}`;
  return `wa_group_${chatId}_user_${senderId}`;
}

export function getWhatsappSessionLabel(chatName: string, senderName: string, isGroup: boolean): string {
  if (!isGroup) return `WA DM ${senderName}`;
  return `WA ${chatName} / ${senderName}`;
}
