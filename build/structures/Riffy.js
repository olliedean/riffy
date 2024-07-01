const { EventEmitter } = require("events");
const { Node } = require("./Node");
const { Player } = require("./Player");
const { Track } = require("./Track");
const { version: pkgVersion } = require("../../package.json")

const versions = ["v3", "v4"];

class Riffy extends EventEmitter {
  constructor(client, nodes, options) {
    super();
    if (!client) throw new Error("Client is required to initialize Riffy");
    if (!nodes) throw new Error("Nodes are required to initialize Riffy");
    if (!options.send) throw new Error("Send function is required to initialize Riffy");

    this.client = client;
    this.nodes = nodes;
    this.nodeMap = new Map();
    this.players = new Map();
    this.options = options;
    this.clientId = null;
    this.initiated = false;
    this.send = options.send || null;
    this.defaultSearchPlatform = options.defaultSearchPlatform || "ytmsearch";
    this.restVersion = options.restVersion || "v3";
    this.tracks = [];
    this.loadType = null;
    this.playlistInfo = null;
    this.pluginInfo = null;
    this.plugins = options.plugins;
    /**
     * @description Package Version Of Riffy
     */
    this.version = pkgVersion;

    if (this.restVersion && !versions.includes(this.restVersion)) throw new RangeError(`${this.restVersion} is not a valid version`);
  }

  get leastUsedNodes() {
    return [...this.nodeMap.values()]
      .filter((node) => node.connected)
      .sort((a, b) => a.rest.calls - b.rest.calls);
  }

  init(clientId) {
    if (this.initiated) return this;
    this.clientId = clientId;
    this.nodes.forEach((node) => this.createNode(node));
    this.initiated = true;

    if (this.plugins) {
      this.plugins.forEach((plugin) => {
        plugin.load(this);
      });
    }
  }

  createNode(options) {
    const node = new Node(this, options, this.options);
    this.nodeMap.set(options.name || options.host, node);
    node.connect();

    this.emit("nodeCreate", node);
    return node;
  }

  destroyNode(identifier) {
    const node = this.nodeMap.get(identifier);
    if (!node) return;
    node.disconnect();
    this.nodeMap.delete(identifier);
    this.emit("nodeDestroy", node);
  }

  updateVoiceState(packet) {
    if (!["VOICE_STATE_UPDATE", "VOICE_SERVER_UPDATE"].includes(packet.t)) return;
    const player = this.players.get(packet.d.guild_id);
    if (!player) return;

    if (packet.t === "VOICE_SERVER_UPDATE") {
      player.connection.setServerUpdate(packet.d);
    } else if (packet.t === "VOICE_STATE_UPDATE") {
      if (packet.d.user_id !== this.clientId) return;
      player.connection.setStateUpdate(packet.d);
    }
  }

  fetchRegion(region) {
    const nodesByRegion = [...this.nodeMap.values()]
      .filter((node) => node.connected && node.regions?.includes(region?.toLowerCase()))
      .sort((a, b) => {
        const aLoad = a.stats.cpu
          ? (a.stats.cpu.systemLoad / a.stats.cpu.cores) * 100
          : 0;
        const bLoad = b.stats.cpu
          ? (b.stats.cpu.systemLoad / b.stats.cpu.cores) * 100
          : 0;
        return aLoad - bLoad;
      });

    return nodesByRegion;
  }

  createConnection(options) {
    if (!this.initiated) throw new Error("You have to initialize Riffy in your ready event");

    const player = this.players.get(options.guildId);
    if (player) return player;

    if (this.leastUsedNodes.length === 0) throw new Error("No nodes are available");

    let node;
    if (options.region) {
      const region = this.fetchRegion(options.region)[0];
      node = this.nodeMap.get(region.name || this.leastUsedNodes[0].name);
    } else {
      node = this.nodeMap.get(this.leastUsedNodes[0].name);
    }

    if (!node) throw new Error("No nodes are available");

    return this.createPlayer(node, options);
  }
    
  fetchRegion(region) {
     const nodesByRegion = [...this.nodeMap.values()]
       .filter((node) => node.connected && node.regions == region?.toLowerCase())
       .sort((a, b) => b.rest.calls - a.rest.calls);
    
     return nodesByRegion;
  }

  createPlayer(node, options) {
    const player = new Player(this, node, options);
    this.players.set(options.guildId, player);

    player.connect(options);

    this.emit("playerCreate", player);
    return player;
  }

  destroyPlayer(guildId) {
    const player = this.players.get(guildId);
    if (!player) return;
    player.destroy();
    this.players.delete(guildId);

    this.emit("playerDestroy", player);
  }

  removeConnection(guildId) {
    this.players.get(guildId)?.destroy();
    this.players.delete(guildId);
  }

  /**
   * @param {Object} param0 
   * @param {string} param0.query used for searching as a search Query  
   * @param {*} param0.source  A source to search the query on example:ytmsearch for youtube music
   * @param {*} param0.requester the requester who's requesting 
   * @param {string? | Node?} param0.node  the node to request the query on either use node identifier/name or the node class itself
   * @returns -- returned properties values are nullable if lavlink doesn't  give them
   * */
  async resolve({ query, source, requester, node }) {
    try {
      if (!this.initiated) throw new Error("You have to initialize Riffy in your ready event");
      
      if(node && (typeof node !== "string" && !(node instanceof Node))) throw new Error(`'node' property must either be an node identifier/name('string') or an Node/Node Class, But Received: ${typeof node}`)

      const sources = source || this.defaultSearchPlatform;

      const requestNode = (node && typeof node === 'string' ? this.nodeMap.get(node) : node) || this.leastUsedNodes[0];
      if (!requestNode) throw new Error("No nodes are available.");

      const regex = /^https?:\/\//;
      const identifier = regex.test(query) ? query : `${sources}:${query}`;

      let response = await requestNode.rest.makeRequest(`GET`, `/${requestNode.rest.version}/loadtracks?identifier=${encodeURIComponent(identifier)}`);

      // for resolving identifiers - Only works in Spotify and Youtube
      if (response.loadType === "empty" || response.loadType === "NO_MATCHES") {
        response = await requestNode.rest.makeRequest(`GET`, `/${requestNode.rest.version}/loadtracks?identifier=https://open.spotify.com/track/${query}`);
        if (response.loadType === "empty" || response.loadType === "NO_MATCHES") {
          response = await requestNode.rest.makeRequest(`GET`, `/${requestNode.rest.version}/loadtracks?identifier=https://www.youtube.com/watch?v=${query}`);
        }
      }

      if (requestNode.rest.version === "v4") {
        if (response.loadType === "track") {
          this.tracks = response.data ? [new Track(response.data, requester, requestNode)] : [];
        } else if (response.loadType === "playlist") {
          this.tracks = response.data?.tracks ? response.data.tracks.map((track) => new Track(track, requester, requestNode)) : [];
        } else {
          this.tracks = response.loadType === "search" && response.data ? response.data.map((track) => new Track(track, requester, requestNode)) : [];
        }
      } else {
        this.tracks = response?.tracks ? response.tracks.map((track) => new Track(track, requester, requestNode)) : [];
      }
      
      if (
        requestNode.rest.version === "v4" &&
        response.loadType === "playlist"
      ) {
        this.playlistInfo = response.data?.info ?? null;
      } else {
        this.playlistInfo = response.playlistInfo ?? null;
      }

      this.loadType = response.loadType ?? null
      this.pluginInfo = response.pluginInfo ?? null;

      return {
        loadType: this.loadType,
        exception: this.loadType == "error" ? response.data : this.loadType == "LOAD_FAILED" ? response.exception : null,
        playlistInfo: this.playlistInfo,
        pluginInfo: this.pluginInfo,
        tracks: this.tracks,
      };
    } catch (error) {
      throw new Error(error);
    }
  }

  get(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error(`Player not found for ${guildId} guildId`);
    return player;
  }
}

module.exports = { Riffy };
