import mongoose from 'mongoose'

let isConnected = false

export async function connectToDatabase() {
	if (isConnected) {
		return mongoose
	}

	try {
		const mongoUri = process.env.DATABASE_URL
		if (!mongoUri) {
			throw new Error('DATABASE_URL is not defined')
		}

		await mongoose.connect(mongoUri)
		isConnected = true
		console.log('Connected to MongoDB')
		return mongoose
	} catch (error) {
		console.error('Database connection error: ', error)
		throw error
	}
}
