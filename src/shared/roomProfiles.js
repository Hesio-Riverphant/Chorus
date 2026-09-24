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
      return { ...bot, nativeCapabilities };
    }).filter(Boolean);
  }
  return { members, isLocal };
});
