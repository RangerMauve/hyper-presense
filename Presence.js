const EventEmitter = require('events')
const { DiGraph, hasPath } = require('jsnetworkx')
const codecs = require('codecs')

const { Type, Message } = require('./messages')

const DEFAULT_ENCODING = 'json'

module.exports = class Presence extends EventEmitter {
  constructor (id, { encoding } = {}) {
    super()
    if (!id) throw new TypeError('Must provide id for self')

    this.id = id.toString('hex')

    this.bootstrapped = false
    this.graph = new DiGraph()
    this.connectedTo = new Set()
    this.data = {}
    this.encoding = codecs(encoding || DEFAULT_ENCODING)
  }

  broadcast (data, ttl) {
    throw new TypeError('Broadcast has not been implemented')
  }

  setData (data) {
    this.data = data

    this.setPeer(this.id, data)

    this.broadcastData()
  }

  broadcastData () {
    const rawData = this.data
    if (!rawData) return
    const data = this.encoding.encode(rawData)
    this.broadcast(Message.encode({
      type: Type.STATE,
      data
    }))
  }

  onAddPeer (id) {
    this.connectedTo.add(id.toString('hex'))

    this.addPeerConnection(this.id, id)

    this.recalculate()

    this.broadcast(Message.encode({
      type: Type.CONNECTED,
      id
    }))

    this.broadcastData()

    if (this.bootstrapped) return
    this.broadcast(Message.encode({
      type: Type.BOOTSTRAP_REQUEST
    }), 0)
  }

  onRemovePeer (id) {
    this.connectedTo.delete(id.toString('hex'))

    this.removePeerConnection(this.id, id)

    this.recalculate()

    this.broadcast(Message.encode({
      type: Type.DISCONNECTED,
      id
    }))
  }

  onGetBroadcast (message, id) {
    const decoded = Message.decode(message)
    const { type } = decoded
    if (!type) throw new Error('Missing Type In Message')

    if (type === Type.STATE) {
      const { data: rawData } = decoded
      const data = this.encoding.decode(rawData)
      this.setPeer(id, data)
      this.emit('peer-data', data, id)
      this.recalculate()
    } else if (type === Type.CONNECTED) {
      const { id: toId } = decoded
      this.addPeerConnection(id, toId)
      this.emit('peer-add-seen', id, toId)
      this.recalculate()
    } else if (type === Type.DISCONNECTED) {
      const { id: toId } = decoded
      this.removePeerConnection(id, toId)
      this.emit('peer-remove-seen', id, toId)
      this.recalculate()
    } else if (type === Type.BOOTSTRAP_REQUEST) {
      const bootstrap = this.getBootstrapInfo()
      this.broadcast(Message.encode({
        type: Type.BOOTSTRAP_RESPONSE,
        bootstrap
      }), 0)
    } else if (type === Type.BOOTSTRAP_RESPONSE) {
      const { bootstrap } = message
      this.bootstrapFrom(bootstrap)
    }
  }

  hasSeenPeer (id) {
    return this.graph.hasNode(id.toString('hex'))
  }

  setPeer (id, data) {
    this.graph.addNode(id.toString('hex'), data)
  }

  removePeer (id) {
    this.graph.removeNode(id.toString())
  }

  getPeer (id) {
    return this.graph.node.get(id.toString('hex')) || {}
  }

  ensurePeer (id) {
    if (!this.hasSeenPeer(id)) this.setPeer(id, {})
  }

  addPeerConnection (origin, destination) {
    this.ensurePeer(origin)
    this.ensurePeer(destination)
    this.graph.addEdge(origin.toString('hex'), destination.toString('hex'))
  }

  removePeerConnection (origin, destination) {
    this.ensurePeer(origin)
    this.ensurePeer(destination)
    this.graph.removeEdge(origin.toString('hex'), destination.toString('hex'))
  }

  bootstrapFrom (bootstrap) {
    if (this.bootstrapped) return

    for (const id in bootstrap) {
      const { data, connectedTo } = bootstrap[id]
      const parsedData = data ? this.encoding.decode(data) : null
      if (id === this.id) continue
      this.removePeer(id)
      this.setPeer(id, parsedData)
      for (const connection of connectedTo) {
        this.addPeerConnection(id, connection)
      }
    }

    this.emit('bootstrapped')

    this.recalculate()
  }

  getBootstrapInfo () {
    const state = {}
    for (const [id, rawData] of this.graph.nodes(true)) {
      const connectedTo = this.graph.neighbors(id).map((id) => Buffer.from(id, 'hex'))
      const data = rawData ? this.encoding.encode(rawData) : null
      state[id] = { data, connectedTo }
    }

    return state
  }

  // Calculate who's online and emit an event
  recalculate () {
    const online = this.graph.nodes().filter((id) => {
      return hasPath(this.graph, { source: this.id, target: id })
    })

    const offline = this.graph.nodes().filter((id) => {
      return !hasPath(this.graph, { source: this.id, target: id })
    })

    for (const id of offline) this.graph.removeNode(id)

    this.emit('online', online)
  }

  getPeerData (id) {
    return this.graph.node.get(id)
  }
}
