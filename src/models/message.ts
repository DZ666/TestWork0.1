import { ObjectId } from 'mongodb'

export interface Message {
  _id?: ObjectId
  user: string
  text: string
  createdAt: Date
}
