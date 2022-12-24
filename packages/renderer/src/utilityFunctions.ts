import type {Player} from '../../preload/src/models/Player';

const teamColors = ['#161616','#ffd700','#9400d3','#b8860b','#800080','#da70d6','#8a2be2','#fa8072','#00ff00','#a020f0','#556b2f','#66cdaa','#ff8c00','#ffa07a','#deb887','#f0e68c','#adff2f','#e9967a','#2e8b57','#20b2aa','#c71585','#ff69b4','#808080','#f4a460','#b03060','#483d8b','#00ffff','#3cb371','#6495ed','#87cefa','#ff1493','#add8e6','#0000ff','#dcdcdc','#696969','#8fbc8f','#b0c4de','#db7093','#a9a9a9','#9932cc','#191970','#ff0000','#7b68ee','#4b0082','#4169e1','#4682b4','#d2691e','#d8bfd8','#a0522d','#eee8aa','#7fffd4','#0000cd','#ff00ff','#663399','#ffff00','#bc8f8f','#afeeee','#808000','#a52a2a','#dc143c','#dda0dd','#00ff7f','#ba55d3','#6a5acd','#1e90ff','#ffc0cb','#ff7f50','#cd5c5c','#87ceeb','#ffa500','#5f9ea0','#f08080','#7cfc00','#008b8b','#32cd32','#bdb76b','#ff4500','#40e0d0','#6b8e23','#00fa9a','#00bfff','#2f4f4f','#ee82ee','#90ee90','#cd853f','#008000','#ff6347','#800000','#8b4513','#9370db','#00ced1','#9acd32','#daa520','#006400','#ffe4b5','#b22222','#ffe4c4','#ffff54','#000080','#708090'];

function convertTimestamp(timestamp:Date) {
	const dt = new Date(timestamp);
	dt.setHours(dt.getHours() + dt.getTimezoneOffset() / 60);
	return dt.toLocaleString('en-US', {
		month: 'long',
		day: '2-digit',
		year: 'numeric',
	}) + ' ' + dt.toLocaleString('en-US', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: true,
	});
}

function convertDuration(duration:number) {
  return `${Math.floor(duration / 1000 / 60)} mins ${Math.round(duration / 1000 % 60).toString().padStart(2, '0')} secs`;
}

function convertKillTime(time:number) {
  return `${Math.floor(time / 1000 / 60)}:${Math.round(time / 1000 % 60).toString().padStart(2, '0')}`;
}

function copyField(event:MouseEvent, information: string, data:string) {
  navigator.clipboard.writeText(data);
  const x = event.clientX;
  const y = event.clientY;
  const div = document.createElement('div');
  div.className = 'tooltip frame fade';
  div.innerText = `Copied ${information}!`;
  document.body.appendChild(div);
  div.style.top = `${y - div.clientHeight - 8}px`;
  div.style.left = `${x - (div.clientWidth / 2)}px`;
  setTimeout(() => { div.remove(); }, 1600);
}

function getSkin(player:Player) {
  if (player == null) { return ''; }
  return player.isBot == true ? 'epic' : player.skin ?? 'sniper';
}

function getTeamColor(team:number) {
  team = team % 100;
  return teamColors.at(team - 1);
}

export { convertDuration, convertTimestamp, convertKillTime, copyField, getSkin, getTeamColor};
