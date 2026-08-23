const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });
app.use(express.static('public'));

const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const nowTime = () => new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
const clean = (v, max=1000) => String(v ?? '').trim().slice(0,max);
const id = (prefix='x') => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;

function seed(){
  return {
    servers:[{
      id:'main', name:'Servidor principal', owner:'', invite:'D2-'+Math.random().toString(36).slice(2,8).toUpperCase(),
      textChannels:[{id:'geral',name:'geral',topic:'Conversa geral do servidor'},{id:'games',name:'games',topic:'Fale sobre jogos'},{id:'memes',name:'memes',topic:'Memes e diversão'}],
      voiceChannels:[{id:'voz-geral',name:'Geral'},{id:'sala-2',name:'Sala 2'}],
      roles:{}, messages:{geral:[],games:[],memes:[]}
    }],
    dms:{}, friends:{}, seq:1
  };
}
function load(){ try{ return {...seed(), ...JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}; }catch{ return seed(); } }
let db = load();
function save(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }catch(e){ console.error('save',e); } }
function getServer(serverId){ return db.servers.find(s=>s.id===serverId); }
function publicServer(s){ return {id:s.id,name:s.name,owner:s.owner,invite:s.invite,textChannels:s.textChannels,voiceChannels:s.voiceChannels}; }
function roleFor(s, username){ if(!s) return 'Membro'; if(s.owner===username) return 'Dono'; return s.roles?.[username] || 'Membro'; }
function canManage(s, username){ return ['Dono','Admin','Moderador'].includes(roleFor(s,username)); }
function safeProfile(p={}){ return {avatar:typeof p.avatar==='string'&&p.avatar.startsWith('data:image/')&&p.avatar.length<300000?p.avatar:'',color:/^#[0-9a-f]{6}$/i.test(p.color||'')?p.color:'#5865f2',status:clean(p.status||'Online',40),presence:['Online','Ausente','Não perturbe','Invisível'].includes(p.presence)?p.presence:'Online'}; }

const users = new Map(); // socket.id -> {username, profile, serverId, muted, deafened}
const voiceUsers = new Map(); // socket.id -> {serverId, channelId}
const usernameToSocket = () => new Map([...users.entries()].map(([sid,u])=>[u.username,sid]));
function publicUsers(serverId){
  const s=getServer(serverId);
  return [...users.entries()].filter(([,u])=>u.serverId===serverId).map(([sid,u])=>({id:sid,username:u.username,profile:u.profile,role:roleFor(s,u.username),voice:voiceUsers.get(sid)||null,muted:!!u.muted,deafened:!!u.deafened}));
}
function emitState(serverId){ if(!serverId)return; io.to(`server:${serverId}`).emit('users', publicUsers(serverId)); io.to(`server:${serverId}`).emit('server-state',{server:publicServer(getServer(serverId)),users:publicUsers(serverId)}); }
function ensureServerOwner(s, username){ if(!s.owner){ s.owner=username; save(); } }
function msgList(s,ch){ s.messages[ch] ||= []; return s.messages[ch]; }
function dmKey(a,b){ return [a,b].sort((x,y)=>x.localeCompare(y)).join('::'); }
function friendSet(name){ db.friends[name] ||= []; return db.friends[name]; }

io.on('connection', socket=>{
  socket.on('register', data=>{
    const username=clean(data?.username,24); if(!username) return;
    const serverId=getServer(data?.serverId)?.id || db.servers[0].id;
    const s=getServer(serverId); ensureServerOwner(s, username);
    users.set(socket.id,{username,profile:safeProfile(data?.profile),serverId,muted:false,deafened:false});
    socket.join(`server:${serverId}`);
    socket.emit('bootstrap',{servers:db.servers.map(publicServer),server:publicServer(s),history:s.messages,friends:friendSet(username)});
    emitState(serverId); io.to(`server:${serverId}`).emit('system',`${username} entrou no servidor.`);
  });

  socket.on('switch-server', serverId=>{
    const u=users.get(socket.id), s=getServer(clean(serverId,80)); if(!u||!s)return;
    socket.leave(`server:${u.serverId}`); const old=u.serverId; u.serverId=s.id; socket.join(`server:${s.id}`);
    socket.emit('bootstrap',{servers:db.servers.map(publicServer),server:publicServer(s),history:s.messages,friends:friendSet(u.username)});
    emitState(old); emitState(s.id);
  });

  socket.on('server-create', d=>{
    const u=users.get(socket.id); if(!u)return; const name=clean(d?.name,40); if(!name)return;
    const sid=id('srv'); const s={id:sid,name,owner:u.username,invite:'D2-'+Math.random().toString(36).slice(2,8).toUpperCase(),textChannels:[{id:'geral',name:'geral',topic:'Conversa geral'}],voiceChannels:[{id:'voz-geral',name:'Geral'}],roles:{},messages:{geral:[]}};
    db.servers.push(s); save(); io.emit('servers-updated',db.servers.map(publicServer)); socket.emit('server-created',publicServer(s));
  });

  socket.on('server-join-invite', code=>{
    const u=users.get(socket.id); if(!u)return; const s=db.servers.find(x=>x.invite===clean(code,30).toUpperCase());
    if(!s)return socket.emit('notice','Convite inválido.'); socket.emit('server-created',publicServer(s));
  });

  socket.on('profile-update', p=>{const u=users.get(socket.id);if(!u)return;u.profile=safeProfile({...u.profile,...p});emitState(u.serverId)});
  socket.on('presence', state=>{const u=users.get(socket.id);if(!u)return;u.profile.presence=['Online','Ausente','Não perturbe','Invisível'].includes(state)?state:'Online';emitState(u.serverId)});

  socket.on('channel-create', d=>{
    const u=users.get(socket.id), s=getServer(u?.serverId); if(!u||!s||!canManage(s,u.username))return socket.emit('notice','Você não tem permissão para criar canais.');
    const name=clean(d?.name,30).toLowerCase().replace(/[^a-z0-9áéíóúãõç_-]+/gi,'-'); if(!name)return;
    if(d?.type==='voice'){const c={id:id('v'),name:clean(d?.display||name,30)};s.voiceChannels.push(c)}else{const c={id:id('t'),name,topic:clean(d?.topic||'Novo canal',80)};s.textChannels.push(c);s.messages[c.id]=[]}
    save(); emitState(s.id);
  });

  socket.on('invite-create',()=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(u&&s)socket.emit('invite-code',s.invite)});
  socket.on('role-set',d=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(!u||!s||!['Dono','Admin'].includes(roleFor(s,u.username)))return socket.emit('notice','Sem permissão.');const target=clean(d?.username,24);const role=['Admin','Moderador','Membro'].includes(d?.role)?d.role:'Membro';if(target===s.owner)return socket.emit('notice','O dono não pode ter o cargo alterado.');s.roles[target]=role;save();emitState(s.id)});
  socket.on('kick-user',name=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(!u||!s||!canManage(s,u.username))return;const target=clean(name,24), map=usernameToSocket(), sid=map.get(target);if(!sid||target===s.owner)return;io.to(sid).emit('kicked','Você foi removido deste servidor.');io.sockets.sockets.get(sid)?.disconnect(true)});

  socket.on('chat-send', d=>{
    const u=users.get(socket.id), s=getServer(u?.serverId); if(!u||!s)return; const ch=clean(d?.channel,80); if(!s.textChannels.some(c=>c.id===ch))return;
    const text=clean(d?.message,1500); let a=d?.attachment; if(a&&(!String(a.data||'').startsWith('data:')||String(a.data).length>1700000))a=null; if(!text&&!a)return;
    const item={id:'m'+(db.seq++),username:u.username,profile:u.profile,role:roleFor(s,u.username),message:text,channel:ch,time:nowTime(),edited:false,replyTo:clean(d?.replyTo,30)||'',attachment:a?{name:clean(a.name,100),type:clean(a.type,80),data:a.data}:null,reactions:{}};
    msgList(s,ch).push(item); if(msgList(s,ch).length>250)msgList(s,ch).shift(); save(); io.to(`server:${s.id}`).emit('chat-message',item);
  });
  socket.on('message-edit',d=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(!u||!s)return;const m=msgList(s,clean(d?.channel,80)).find(x=>x.id===d?.id);if(!m||m.username!==u.username)return;const text=clean(d?.message,1500);if(!text)return;m.message=text;m.edited=true;save();io.to(`server:${s.id}`).emit('message-updated',{channel:d.channel,message:m})});
  socket.on('message-delete',d=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(!u||!s)return;const list=msgList(s,clean(d?.channel,80));const i=list.findIndex(x=>x.id===d?.id);if(i<0)return;const m=list[i];if(m.username!==u.username&&!canManage(s,u.username))return;list.splice(i,1);save();io.to(`server:${s.id}`).emit('message-deleted',{channel:d.channel,id:d.id})});
  socket.on('reaction',d=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(!u||!s)return;const emoji=clean(d?.emoji,8);if(!['👍','❤️','😂','🔥','🎉'].includes(emoji))return;const m=msgList(s,clean(d?.channel,80)).find(x=>x.id===d?.id);if(!m)return;m.reactions[emoji] ||= [];const arr=m.reactions[emoji], i=arr.indexOf(u.username);if(i>=0)arr.splice(i,1);else arr.push(u.username);save();io.to(`server:${s.id}`).emit('message-updated',{channel:d.channel,message:m})});
  socket.on('typing',d=>{const u=users.get(socket.id);if(u)socket.to(`server:${u.serverId}`).emit('typing',{username:u.username,channel:clean(d?.channel,80),state:!!d?.state})});

  socket.on('friend-add', name=>{const u=users.get(socket.id),target=clean(name,24);if(!u||!target||target===u.username)return;const a=friendSet(u.username),b=friendSet(target);if(!a.includes(target))a.push(target);if(!b.includes(u.username))b.push(u.username);save();socket.emit('friends',a);const sid=usernameToSocket().get(target);if(sid)io.to(sid).emit('friends',b)});
  socket.on('dm-history', name=>{const u=users.get(socket.id),target=clean(name,24);if(!u||!target)return;socket.emit('dm-history',{with:target,messages:db.dms[dmKey(u.username,target)]||[]})});
  socket.on('dm-send',d=>{const u=users.get(socket.id),target=clean(d?.to,24),text=clean(d?.message,1500);if(!u||!target||!text)return;const k=dmKey(u.username,target);db.dms[k] ||= [];const item={id:'d'+(db.seq++),from:u.username,to:target,message:text,time:nowTime()};db.dms[k].push(item);if(db.dms[k].length>250)db.dms[k].shift();save();socket.emit('dm-message',item);const sid=usernameToSocket().get(target);if(sid)io.to(sid).emit('dm-message',item)});

  socket.on('signal',d=>{if(d?.to)io.to(d.to).emit('signal',{from:socket.id,data:d.data})});
  socket.on('voice-join', channelId=>{const u=users.get(socket.id),s=getServer(u?.serverId);if(!u||!s||!s.voiceChannels.some(c=>c.id===channelId))return;const old=voiceUsers.get(socket.id);if(old)socket.to(`server:${old.serverId}`).emit('voice-user-left',socket.id);voiceUsers.set(socket.id,{serverId:s.id,channelId});const same=[...voiceUsers.entries()].filter(([sid,v])=>sid!==socket.id&&v.serverId===s.id&&v.channelId===channelId).map(([sid])=>sid);socket.emit('voice-users',same);socket.to(`server:${s.id}`).emit('voice-user-joined',{id:socket.id,serverId:s.id,channelId});emitState(s.id)});
  socket.on('voice-leave',()=>{const u=users.get(socket.id),v=voiceUsers.get(socket.id);if(v){voiceUsers.delete(socket.id);socket.to(`server:${v.serverId}`).emit('voice-user-left',socket.id);emitState(v.serverId)}else if(u)emitState(u.serverId)});
  socket.on('voice-mute',state=>{const u=users.get(socket.id);if(u){u.muted=!!state;emitState(u.serverId)}});
  socket.on('voice-deafen',state=>{const u=users.get(socket.id);if(u){u.deafened=!!state;emitState(u.serverId)}});
  socket.on('speaking',state=>{const u=users.get(socket.id);if(u)socket.to(`server:${u.serverId}`).emit('speaking',{id:socket.id,state:!!state})});

  socket.on('disconnect',()=>{const u=users.get(socket.id),v=voiceUsers.get(socket.id);if(v){voiceUsers.delete(socket.id);socket.to(`server:${v.serverId}`).emit('voice-user-left',socket.id)}users.delete(socket.id);if(u){io.to(`server:${u.serverId}`).emit('system',`${u.username} saiu do servidor.`);emitState(u.serverId)}});
});

server.listen(process.env.PORT||3000,()=>console.log(`Discord 2.0 V6: http://localhost:${process.env.PORT||3000}`));
