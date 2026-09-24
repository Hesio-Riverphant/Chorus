(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomProfiles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const inherit = () => ({ mode: 'inherit', mcp: [], plugins: [] });
  function isLocal(room) { return !!(room?.parentRoomId || room?.memberProfiles); }
  function members(room, bots, settings = {}) {
    if (!room) return [];
    const global = new Map(bots.map(bot => [bot.id, bot]));
    return (room.botIds || []).map(id => {
      const bot = room.memberProfiles?.[id] || global.get(id);
      if (!bot) return null;
      const nativeCapabilities = room.memberCapabilities?.[id] || (isLocal(room)
        ? bot.nativeCapabilities : settings.agentCapabilities?.[bot.cliType]) || inherit();
      // Host assignment belongs to this room, including side-chat snapshots.
      // Project it into the profile consumed by UI and prompts, never global bots.
      const profile = room.memberRoles?.[id] || bot;
      const role = id === room.moderatorBotId ? '主持人' : profile.role === '主持人' ? '协作者' : profile.role;
      return { ...bot, role, customRole: role !== profile.role || id === room.moderatorBotId ? false : profile.customRole, nativeCapabilities };
    }).filter(Boolean);
  }
  return { members, isLocal };
});
