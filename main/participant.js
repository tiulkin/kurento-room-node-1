module.exports = class Participant {
    constructor(roomManager, socket, request ) {
        this.socket = socket;
        this.client = request.client;
        this.roomManager = roomManager;
        this.kms = roomManager.kms;
        this.sessionId = request.headers['sec-websocket-key'];
        this.roomName = null;
        this.endpoint = null
        this.isPublishing = null;
        this.subscriberEndpoints = {};
        this.candidates = {};

        this.state = {
            id: socket.id,
            name: null
        };

        socket.on('message', this.processMessage.bind(this))
        socket.on('close', ()=>{
            if(this.id) {
                this.notifyUserLeft();
                this.closeEndpoints();
                this.roomManager.unregisterParticipant(this.id)
                console.log('Connection ' + this.id + ' ' + this.sessionId + ' closed');
            }
        });
        socket.on('error', ()=>{
            if(this.id) {
                this.stop();
                this.roomManager.unregisterParticipant(this.id)
                console.log('Connection ' + this.sessionId + ' error');
            }
        });

        console.log(`Received new client : ${this.client}`);
    }

    processMessage(message){
        // console.log('message for' + this.id + ':')
        // console.log(message)

        try {
            const messageData = JSON.parse(message);
            const method = messageData?.method;
            this[method](messageData);
        } catch (e) {
            console.warn(e)
        }
    }

    sendMessage(message){
        console.log(message);
    }

    ping(message) {
        // console.log(this.client)
        this.socket?.send(JSON.stringify({
            id: message?.id,
            jsonrpc: '2.0',
            result: {value: 'pong'}
        }));
    }

    joinRoom(message) {
        this.roomName = message.params.room;
        if(this.roomManager.getParticipantById(message.params.user)) {
            this.socket?.send(JSON.stringify({
                id: message.id,
                error:{
                    code:104,
                    message: `User ${this.message.params.user} already exists in room ${this.roomName}`
                },
                jsonrpc: '2.0'
            }))
        } else {
            this.id = message.params.user;
            // console.log('roommates:', this.roomManager.getParticipantsByRoom(this.roomName))
            this.roomManager.registerParticipant(this);
            this.roomManager.addParticipantToRoom(this.roomName, this)

            this.socket?.send(JSON.stringify({
                id: message.id,
                result: {
                    value: this.roomManager.getParticipantsByRoom(this.roomName)
                        .filter(participant => participant.getId() !== this.getId())
                        .map(participant => ({
                            id: participant.getId(),
                            streams: participant.isPublishing ? ['webcam'] : []
                        }))
                },
                jsonrpc: '2.0'
            }))
        }
    }

    leaveRoom(){
        if(!this.id)return;
        this.roomManager.unregisterParticipant(this.id)
        this.stop()
    }
    stop(){
        this.notifyUserLeft();
        this.socket?.close();
        this.socket=null;
    }

    notifyUserLeft(){
        this.roomManager.getParticipantsByRoom(this.roomName)
            .filter(participant => participant.getId() !== this.getId())
            .forEach(participant => participant.getSocket().send(JSON.stringify({
                method:'participantLeft',
                params:{'name':this.id},
                jsonrpc:'2.0'
            })))
    }

    closeEndpoints(){
        this.endpoint?.release();
        Object.values(this.subscriberEndpoints).forEach(endpoint=>endpoint.release())
    }

    publishVideo(message){
        if(!this.id)return;
        const sdpOffer = message.params.sdpOffer
        const id = message.id

        this.roomManager.addPublisherEndpoint(this.roomName, this).then(endpoint => {
            this.endpoint = endpoint;
            while(this.candidates[this.id]?.length) {
                const candidate =this.candidates[this.id].shift()
                endpoint.addIceCandidate(candidate);
            }

            endpoint.on('IceComponentStateChange',event=> {
                console.log('event.state', event.state);
                if (event.state === 'CONNECTED') {
                    this.isPublishing = true;
                    this.roomManager.addPublisherToRoom(this.roomName, this.id)
                }
            })
            // endpoint.on('NewCandidatePairSelected',event=> {console.log('NewCandidatePairSelected',event)})

            endpoint.on('OnIceCandidate', event=> {
                var candidate = this.kms.Ice(event.candidate);
                // console.log('candidate', candidate);
                this.socket?.send(JSON.stringify({
                    jsonrpc: '2.0',
                    method : 'iceCandidate',
                    params : {endpointName:this.id, ...candidate}
                }));
            });

            endpoint.processOffer(sdpOffer, (error, sdpAnswer) =>{
                if (error) {
                    // stop(sessionId);
                    return callback(error);
                }

                this.socket?.send(JSON.stringify({
                    id,
                    result : {sdpAnswer, sessionId: this.session},
                    jsonrpc: '2.0'
                }));
            });

            endpoint.gatherCandidates(function(error) {
                if (error) {
                    // stop(sessionId);
                    console.log('gatherCandidates', error)
                    return callback(error);
                }
            });

        })
    }

    onIceCandidate(message) {
        if(!this.id)return;
        const id = message.id;
        const endpointId=message.params.endpointName;
        const candidate = this.kms.Ice(message.params);

        const endpointForIceCandidate = endpointId === this.getId() ? this.endpoint :
            this.roomManager.getParticipantById(endpointId).subscriberEndpoints[this.getId()]
        if(endpointForIceCandidate) {
            endpointForIceCandidate.addIceCandidate(candidate);
        }
        else {
            if (!this.candidates[endpointId]) {
                this.candidates[endpointId] = [candidate]
            }
            else {
                this.candidates[endpointId].push(candidate)
            }
        }
        this.socket?.send(JSON.stringify({
            id,
            result: {sessionId: this.session},
            jsonrpc: '2.0'
        }));
    }

    receiveVideoFrom(message){
        if(!this.id)return;
        const id = message.id;
        const senderId = message.params.sender.split('_')[0];
        const sdpOffer = message.params.sdpOffer;

        console.log(`${this.getId()} receive from ${senderId}`);
        if (senderId === this.getId()) return;

        const sender = this.roomManager.getParticipantById(senderId);
        const senderEndpoint = sender.endpoint;
        if (!sender || !sender.isPublishing || !sender.endpoint) return console.log(`participant ${senderId} is not in room`);

        const roomPipeline = this.roomManager.getPipeline(this.roomName);
        roomPipeline.create('WebRtcEndpoint', (error, receiverEndpoint) => {
            while(this.candidates[senderId]?.length) {
                const candidate =this.candidates[senderId].shift()
                receiverEndpoint.addIceCandidate(candidate);
            }

            console.log('receive video piveline created', error)
            // if (error) {
            //     return callback(error);
            // }
            sender.subscriberEndpoints[this.getId()]=receiverEndpoint;
            receiverEndpoint.on('OnIceCandidate', event => {
                var candidate = this.kms.Ice(event.candidate);

                this.socket?.send(JSON.stringify({
                    jsonrpc: '2.0',
                    method : 'iceCandidate',
                    params : {endpointName:senderId, ...candidate}
                }));
            });

            receiverEndpoint.processOffer(sdpOffer, (error, sdpAnswer) =>{
                if (error) {
                    // stop(sessionId);
                    return callback(error);
                }
                console.log('receiveing video create sdpAnswer', error);
                senderEndpoint.connect(receiverEndpoint, error => {
                    console.log('receiveing video connected',error);
                    this.socket?.send(JSON.stringify({
                        id,
                        result : {sdpAnswer, sessionId: this.session},
                        jsonrpc: '2.0'
                    }));

                    receiverEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            // stop(sessionId);
                            console.log('gatherCandidates', error)
                            return callback(error);
                        }
                    });
                })
            });
        })
    }


    addCandidatesToEndpoint(senderId, endpoint) {
        this.getCandidates(senderId).forEach(({ candidate }) =>
            endpoint.addIceCandidate(candidate)
        );
        return this;
    }


    getId() {
        return this.id;
    }
    getSocket() {
        return this.socket;
    }

}