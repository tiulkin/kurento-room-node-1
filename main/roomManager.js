const WebSocket = require('ws');
const Participant = require('./participant');
const Kms = require('./Kms');

module.exports = class kurentoRoom {
    constructor(server, kmsUri) {
        this.wss = new WebSocket.Server({
            server, clientTracking: true,
            backlog:2000,
            perMessageDeflate:false,
            maxPayload:2000000,
            path : '/room'

        });
        this.initSocketConnection();
        this.kms = new Kms(kmsUri);
        this.participantsByRoom = { /*  roomName: [] */ };
        this.participantsById = { /*  id : participant  */ };
    }

    initSocketConnection() {
        this.wss.on('connection', (ws, request) => {
            new Participant(this,ws,request)
        });
    }

    registerParticipant(participant) {
        if (this.participantsById[participant.getId()]){
            const oldParticipant = this.participantsById[participant.getId()]
            oldParticipant.stop()
        }
        this.participantsById[participant.getId()] = participant;
    }

    unregisterParticipant(id, roomName) {
        const list = this.getParticipantsByRoom(roomName) || [];
        this.participantsByRoom[roomName] = list.filter(participant => participant.id !== id);
        delete this.participantsById[id];
        if (this.participantsByRoom[roomName].length === 0){
            this.removePipeline()
        }
    }

    newPipeline(roomName) {
        return this.kms.newPipeline(roomName);
    }

    addParticipantToRoom(roomName, newParticipant) {
        if (!newParticipant) return;
        if (!this.participantsByRoom[roomName]) this.participantsByRoom[roomName] = [];
        this.participantsByRoom[roomName]
            .filter(participant=>participant.getId()!==newParticipant.getId())
            .forEach(participant => participant.socket.send(JSON.stringify({
            method:'participantJoined',
            jsonrpc: '2.0',
            params: {id: newParticipant.getId()}
        })))
        this.participantsByRoom[roomName].push(newParticipant);

    }

    addPublisherToRoom(roomName, participantId) {
        if (!this.participantsByRoom[roomName]) this.participantsByRoom[roomName] = [];
        this.participantsByRoom[roomName]
            .filter(participant=>participant.getId()!==participantId)
            .forEach(participant => participant.socket.send(JSON.stringify({
                method:'participantPublished',
                jsonrpc: '2.0',
                params: {'id':participantId, streams:[{id:"webcam"}]}
            })))

    }

    addPublisherEndpoint(roomName, participant){
        if (!participant) return;
        console.log(`addParticipantToRoom  ${participant.id}` );
        if (this.getPipeline(roomName)) {
            return this.kms.newWebRtcEndpoint(roomName).then(endpoint => {
                console.log(`created endpoint for ${participant.id}`);
                return endpoint;
            });
        }
        else
        return (this.newPipeline(roomName))
            .then(() => this.kms.newWebRtcEndpoint(roomName))
            .then(endpoint => {
                console.log(`created endpoint for ${participant.id}`);
                return endpoint;
            });
    }

    getPipeline(roomName) {
        return this.kms.pipelines[roomName] || null
    }

    removePipeline(roomName) {
        this.kms.pipelines[roomName]?.release()
        delete this.kms.pipelines[roomName]
    }

    getParticipantById(id) {
        return this.participantsById[id] || null;
    }

    getParticipantsByRoom(roomName) {
        return this.participantsByRoom[roomName] || [];
    }

}