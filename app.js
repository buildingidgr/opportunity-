import amqp from 'amqplib';
import { MongoClient, ObjectId } from 'mongodb';
import express from 'express';
import axios from 'axios';

// Configuration
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'opportunities_db';
const MONGODB_COLLECTION_NAME = process.env.MONGODB_COLLECTION_NAME || 'opportunities';
const PORT = process.env.PORT || 3000;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth-service-url';

// Constants for coordinate masking
const EARTH_RADIUS_KM = 6371; // Earth's radius in kilometers
const MAX_OFFSET_KM = 3; // Maximum offset in kilometers

// Function to generate random coordinates within 5km radius
function getRandomCoordinatesWithinRadius(originalLat, originalLng) {
  // Convert max offset from kilometers to radians
  const maxOffsetRadians = MAX_OFFSET_KM / EARTH_RADIUS_KM;

  // Generate random distance within max offset (in radians)
  const r = maxOffsetRadians * Math.sqrt(Math.random());
  
  // Generate random angle
  const theta = Math.random() * 2 * Math.PI;

  // Calculate offset
  const dx = r * Math.cos(theta);
  const dy = r * Math.sin(theta);

  // Convert latitude offset to degrees
  const newLat = originalLat + (dy * 180) / Math.PI;
  
  // Convert longitude offset to degrees, accounting for latitude
  const newLng = originalLng + (dx * 180) / (Math.PI * Math.cos(originalLat * Math.PI / 180));

  // Round to 4 decimal places (approximately 11 meters precision)
  return {
    lat: Number(newLat.toFixed(4)),
    lng: Number(newLng.toFixed(4))
  };
}

// Create Express app
const app = express();
app.use(express.json());

// Helper function for structured logging
function logEvent(stage, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    stage,
    message,
    ...(data && { data })
  };
  console.log(JSON.stringify(logEntry));
}

// JWT validation middleware
async function validateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logEvent('auth', 'Missing or invalid authorization header');
      return res.status(401).json({ error: 'Authorization header missing or invalid' });
    }

    const token = authHeader.split(' ')[1];
    
    try {
      logEvent('auth', 'Attempting to validate token with auth service', {
        url: `${AUTH_SERVICE_URL}/v1/token/validate`
      });

      // Validate token with auth service
      const response = await axios.post(
        `${AUTH_SERVICE_URL}/v1/token/validate`,
        { token }, 
        {
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          timeout: 5000 // 5 second timeout
        }
      );

      logEvent('auth', 'Received response from auth service', {
        status: response.status,
        statusText: response.statusText,
        isValid: response.data?.isValid
      });

      // Check if the response indicates a valid token
      if (response.data?.isValid && response.data?.userId) {
        // Add user info to request object
        req.user = {
          id: response.data.userId
        };
        
        logEvent('auth', 'Token validated successfully', { 
          userId: req.user.id
        });
        next();
      } else {
        logEvent('auth', 'Token validation failed', { 
          isValid: response.data?.isValid,
          hasUserId: !!response.data?.userId
        });
        res.status(401).json({ 
          error: 'Invalid token',
          details: 'Token validation failed or user ID not provided'
        });
      }
    } catch (error) {
      logEvent('auth', 'Error validating token with auth service', {
        error: error.message,
        code: error.code,
        response: {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data
        }
      });
      
      if (error.code === 'ECONNREFUSED') {
        return res.status(503).json({ 
          error: 'Auth service is unavailable',
          details: 'Could not connect to authentication service'
        });
      }

      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
        return res.status(503).json({ 
          error: 'Auth service timeout',
          details: 'Authentication service took too long to respond'
        });
      }

      if (error.response?.status === 401) {
        return res.status(401).json({ 
          error: 'Invalid token',
          details: error.response.data?.message || 'Token validation failed'
        });
      }
      
      res.status(500).json({ 
        error: 'Error validating token',
        details: 'An unexpected error occurred while validating your token'
      });
    }
  } catch (error) {
    logEvent('auth', 'Unexpected error in token validation', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Internal server error',
      details: 'An unexpected error occurred in the authentication process'
    });
  }
}

async function setupHttpServer(db, channel, connection) {
  // Health check endpoint for Railway - no auth required
  app.get('/', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // Protected routes - require valid JWT
  // Place specific routes before parameterized routes
  app.get('/opportunities/map-coordinates', validateToken, async (req, res) => {
    try {
      logEvent('http', 'Fetching coordinates for map view');

      // Query for public opportunities with location data
      const query = {
        status: 'public',
        'data.project.location.coordinates': { $exists: true }
      };

      const opportunities = await db.collection(MONGODB_COLLECTION_NAME)
        .find(query)
        .project({
          _id: 1,
          'data.project.category.title': 1,
          'data.project.location.coordinates': 1
        })
        .toArray();

      logEvent('mongodb', 'Retrieved opportunities for map', { 
        count: opportunities.length 
      });

      // Transform and mask coordinates
      const mapPoints = opportunities.map(opp => {
        const originalCoords = opp.data?.project?.location?.coordinates;
        if (!originalCoords?.lat || !originalCoords?.lng) {
          return null;
        }

        const maskedCoords = getRandomCoordinatesWithinRadius(
          originalCoords.lat,
          originalCoords.lng
        );

        return {
          id: opp._id,
          category: opp.data?.project?.category?.title || 'Uncategorized',
          coordinates: maskedCoords
        };
      }).filter(Boolean); // Remove null entries

      logEvent('http', 'Sending map coordinates response', { 
        totalPoints: mapPoints.length 
      });

      res.json({
        points: mapPoints,
        metadata: {
          totalPoints: mapPoints.length,
          maskingRadiusKm: MAX_OFFSET_KM,
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logEvent('error', 'Error fetching map coordinates', { 
        error: error.message,
        stack: error.stack 
      });
      res.status(500).json({ 
        error: 'Internal server error',
        details: 'Error fetching map coordinates'
      });
    }
  });

  app.get('/opportunities/my-changes', validateToken, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const userId = req.user.id;

      logEvent('http', 'Starting my-changes request for private opportunities', { 
        userId,
        page,
        limit,
        query: req.query
      });

      // Validate pagination parameters
      if (page < 1 || limit < 1 || limit > 50) {
        logEvent('http', 'Invalid pagination parameters', {
          page,
          limit,
          userId
        });
        return res.status(400).json({
          error: 'Invalid pagination parameters. Page must be >= 1 and limit must be between 1 and 50'
        });
      }

      // Query for opportunities where the user has made status changes
      const query = {
        $and: [
          {
            'statusHistory': {
              $elemMatch: {
                'changedBy': userId
              }
            }
          },
          { 'status': 'private' }
        ]
      };

      logEvent('mongodb', 'Starting my-changes query for private opportunities', { 
        userId,
        userIdType: typeof userId,
        userIdLength: userId.length,
        query: JSON.stringify(query)
      });

      try {
        // Get total count for pagination
        const totalCount = await db.collection(MONGODB_COLLECTION_NAME)
          .countDocuments(query);

        logEvent('mongodb', 'Count query result', { 
          totalCount,
          userId,
          query: JSON.stringify(query),
          collection: MONGODB_COLLECTION_NAME
        });

        // Calculate pagination values
        const totalPages = Math.ceil(totalCount / limit);
        const skip = (page - 1) * limit;

        logEvent('mongodb', 'Pagination values calculated', { 
          totalCount,
          totalPages,
          skip,
          limit
        });

        // Validate requested page number
        if (page > totalPages && totalCount > 0) {
          logEvent('http', 'Page number exceeds total pages', {
            requestedPage: page,
            totalPages,
            totalCount
          });
          return res.status(400).json({
            error: `Page ${page} does not exist. Total pages available: ${totalPages}`,
            totalItems: totalCount,
            totalPages: totalPages,
            suggestion: `Try accessing page 1 to ${totalPages}`
          });
        }

        // Fetch opportunities
        logEvent('mongodb', 'Fetching opportunities', { 
          query: JSON.stringify(query),
          skip,
          limit,
          sort: { 'lastStatusChange.changedAt': -1 }
        });

        const opportunities = await db.collection(MONGODB_COLLECTION_NAME)
          .find(query)
          .sort({ 'lastStatusChange.changedAt': -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        logEvent('mongodb', 'Opportunities fetched', { 
          count: opportunities.length,
          opportunityIds: opportunities.map(o => o._id?.toString())
        });

        if (!opportunities || opportunities.length === 0) {
          logEvent('http', 'No opportunities found', { userId });
          return res.json({
            opportunities: [],
            pagination: {
              currentPage: page,
              totalPages: 0,
              totalItems: 0,
              itemsPerPage: limit,
              hasNextPage: false,
              hasPreviousPage: false
            },
            summary: {
              totalOpportunities: 0,
              totalChanges: 0
            }
          });
        }

        // Process each opportunity to highlight user's changes
        const processedOpportunities = opportunities.map(opportunity => {
          try {
            const userChanges = opportunity.statusHistory?.filter(
              change => change.changedBy === userId
            ) || [];

            logEvent('processing', 'Processing opportunity', { 
              opportunityId: opportunity._id?.toString(),
              totalStatusChanges: opportunity.statusHistory?.length || 0,
              userChangesCount: userChanges.length,
              hasStatusHistory: !!opportunity.statusHistory,
              currentStatus: opportunity.status
            });

            return {
              _id: opportunity._id,
              type: opportunity.type || 'unknown',
              data: opportunity.data || {},
              currentStatus: opportunity.status || 'unknown',
              myChanges: userChanges.map(change => ({
                from: change.from || 'unknown',
                to: change.to || 'unknown',
                changedAt: change.changedAt || new Date()
              })),
              totalChanges: opportunity.statusHistory?.length || 0,
              myChangesCount: userChanges.length,
              lastChange: opportunity.lastStatusChange || null
            };
          } catch (err) {
            logEvent('error', 'Error processing individual opportunity', {
              opportunityId: opportunity._id?.toString(),
              error: err.message
            });
            return null;
          }
        }).filter(Boolean); // Remove any null entries from processing errors

        logEvent('http', 'Successfully processed opportunities', { 
          totalProcessed: processedOpportunities.length,
          totalOriginal: opportunities.length,
          page,
          totalPages,
          userId
        });

        const response = {
          opportunities: processedOpportunities,
          pagination: {
            currentPage: page,
            totalPages,
            totalItems: totalCount,
            itemsPerPage: limit,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1
          },
          summary: {
            totalOpportunities: totalCount,
            totalChanges: processedOpportunities.reduce((sum, opp) => sum + opp.myChangesCount, 0)
          }
        };

        logEvent('http', 'Sending response', { 
          opportunityCount: processedOpportunities.length,
          totalPages,
          currentPage: page,
          totalItems: totalCount
        });

        res.json(response);
      } catch (dbError) {
        logEvent('error', 'Database operation failed', {
          error: dbError.message,
          operation: dbError.operation,
          code: dbError.code
        });
        throw dbError;
      }
    } catch (error) {
      logEvent('error', 'Error in my-changes endpoint', { 
        error: error.message,
        stack: error.stack,
        userId: req.user.id,
        query: req.query,
        errorName: error.name,
        errorCode: error.code
      });
      
      // Handle specific error types
      if (error.name === 'BSONError' || error.name === 'BSONTypeError') {
        return res.status(400).json({ 
          error: 'Invalid ID format',
          details: 'One or more document IDs are in an invalid format'
        });
      }
      
      res.status(500).json({ 
        error: 'Internal server error',
        details: error.message
      });
    }
  });

  // Place parameterized routes after specific routes
  app.get('/opportunities/:id', validateToken, async (req, res) => {
    try {
      const id = req.params.id;
      logEvent('http', 'Fetching opportunity by ID', { id });

      const opportunity = await db.collection(MONGODB_COLLECTION_NAME)
        .findOne({ _id: new ObjectId(id) });

      if (!opportunity) {
        logEvent('http', 'Opportunity not found', { id });
        return res.status(404).json({ error: 'Opportunity not found' });
      }

      // Mask data only if the opportunity is public
      if (opportunity.status === 'public') {
        logEvent('http', 'Masking sensitive data for public opportunity', { id });
        
        // Create a deep copy to avoid modifying the original
        const maskedOpportunity = JSON.parse(JSON.stringify(opportunity));

        // Handle nested data structure
        if (maskedOpportunity.data?.project) {
          // Mask location data
          if (maskedOpportunity.data.project.location) {
            const originalCoords = maskedOpportunity.data.project.location.coordinates;
            const maskedCoords = getRandomCoordinatesWithinRadius(
              originalCoords.lat,
              originalCoords.lng
            );

            maskedOpportunity.data.project.location = {
              address: 'Generated random address',
              coordinates: maskedCoords
            };
          }
        }

        // Mask contact information
        if (maskedOpportunity.data?.contact) {
          maskedOpportunity.data.contact = {
            fullName: 'Generated random name',
            email: 'Generated random email',
            phone: {
              countryCode: '+00',
              number: 'Generated random phone'
            }
          };
        }

        logEvent('http', 'Successfully fetched and masked public opportunity', { 
          id,
          status: 'public'
        });
        return res.json(maskedOpportunity);
      }

      // Return unmasked data for non-public opportunities
      logEvent('http', 'Successfully fetched opportunity', { 
        id,
        status: opportunity.status
      });
      res.json(opportunity);
    } catch (error) {
      if (error.message.includes('ObjectId')) {
        logEvent('http', 'Invalid ID format', { id: req.params.id });
        return res.status(400).json({ error: 'Invalid ID format' });
      }
      
      logEvent('error', 'Error fetching opportunity', { 
        error: error.message,
        stack: error.stack 
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/opportunities', validateToken, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const category = req.query.category;

      // Validate pagination parameters
      if (page < 1 || limit < 1 || limit > 50) {
        return res.status(400).json({
          error: 'Invalid pagination parameters. Page must be >= 1 and limit must be between 1 and 50'
        });
      }

      // Build query
      const query = { status: 'public' };
      if (category) {
        query.category = category;
      }

      logEvent('http', 'Fetching public opportunities', { 
        page,
        limit,
        category: category || 'all',
        query
      });

      // Get total count for pagination
      const totalCount = await db.collection(MONGODB_COLLECTION_NAME)
        .countDocuments(query);

      // Calculate pagination values
      const totalPages = Math.ceil(totalCount / limit);

      // Validate requested page number
      if (page > totalPages && totalCount > 0) {
        return res.status(400).json({
          error: `Page ${page} does not exist. Total pages available: ${totalPages}`,
          totalItems: totalCount,
          totalPages: totalPages,
          suggestion: `Try accessing page 1 to ${totalPages}`
        });
      }

      const skip = (page - 1) * limit;

      // Fetch opportunities
      const opportunities = await db.collection(MONGODB_COLLECTION_NAME)
        .find(query)
        .sort({ _id: -1 }) // Sort by newest first
        .skip(skip)
        .limit(limit)
        .toArray();

      // Mask sensitive data in opportunities
      const maskedOpportunities = opportunities.map(opportunity => {
        // Create a deep copy of the opportunity to avoid modifying the original
        const maskedOpp = JSON.parse(JSON.stringify(opportunity));

        // Handle nested data structure
        if (maskedOpp.data && maskedOpp.data.project) {
          // Mask location data
          if (maskedOpp.data.project.location) {
            const originalCoords = maskedOpp.data.project.location.coordinates;
            const maskedCoords = getRandomCoordinatesWithinRadius(
              originalCoords.lat,
              originalCoords.lng
            );

            maskedOpp.data.project.location = {
              address: 'Generated random address',
              coordinates: maskedCoords
            };
          }

          // Truncate description to 30 words if it exists
          if (maskedOpp.data.project.details?.description) {
            const words = maskedOpp.data.project.details.description.split(/\s+/);
            if (words.length > 30) {
              maskedOpp.data.project.details.description = words.slice(0, 30).join(' ') + '...';
            }
          }
        }

        // Remove contact information
        if (maskedOpp.data) {
          delete maskedOpp.data.contact;
        }

        // Remove status history and last status change
        delete maskedOpp.lastStatusChange;
        delete maskedOpp.statusHistory;

        return maskedOpp;
      });

      logEvent('http', 'Successfully fetched public opportunities', { 
        count: opportunities.length,
        page,
        totalPages,
        query
      });

      // Log the actual documents for debugging
      logEvent('debug', 'Fetched documents', {
        documentCount: maskedOpportunities.length,
        documents: maskedOpportunities.map(doc => ({
          id: doc._id,
          status: doc.status,
          category: doc.category
        }))
      });

      res.json({
        opportunities: maskedOpportunities,
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: totalCount,
          itemsPerPage: limit,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1
        },
        filter: {
          category: category || 'all',
          appliedQuery: query
        }
      });
    } catch (error) {
      logEvent('error', 'Error fetching public opportunities', { 
        error: error.message,
        stack: error.stack 
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/opportunities/stats/growth', validateToken, async (req, res) => {
    try {
      const { interval = 'weekly', startDate, endDate } = req.query;
      const now = new Date();

      // Validate date formats
      const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
      
      if (startDate && !dateRegex.test(startDate)) {
        return res.status(400).json({
          error: 'Invalid startDate format',
          details: 'startDate must be in ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)'
        });
      }

      if (endDate && !dateRegex.test(endDate)) {
        return res.status(400).json({
          error: 'Invalid endDate format',
          details: 'endDate must be in ISO format (YYYY-MM-DDTHH:mm:ss.sssZ)'
        });
      }

      const parsedEndDate = endDate ? new Date(endDate) : now;
      const parsedStartDate = startDate ? new Date(startDate) : new Date(now.setMonth(now.getMonth() - 3));

      // Validate date values
      if (isNaN(parsedStartDate.getTime())) {
        return res.status(400).json({
          error: 'Invalid startDate',
          details: 'startDate could not be parsed into a valid date'
        });
      }

      if (isNaN(parsedEndDate.getTime())) {
        return res.status(400).json({
          error: 'Invalid endDate',
          details: 'endDate could not be parsed into a valid date'
        });
      }

      if (parsedStartDate > parsedEndDate) {
        return res.status(400).json({
          error: 'Invalid date range',
          details: 'startDate must be before or equal to endDate'
        });
      }

      // For hourly interval, limit the date range to 7 days to prevent performance issues
      if (interval === 'hourly' && 
          (parsedEndDate.getTime() - parsedStartDate.getTime()) > 7 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({
          error: 'Invalid date range for hourly interval',
          details: 'Date range for hourly interval cannot exceed 7 days'
        });
      }

      logEvent('http', 'Fetching opportunity growth statistics', { 
        interval,
        startDate: parsedStartDate.toISOString(),
        endDate: parsedEndDate.toISOString()
      });

      // Validate interval
      if (!['hourly', 'daily', 'weekly', 'monthly'].includes(interval)) {
        return res.status(400).json({
          error: 'Invalid interval',
          details: 'Interval must be one of: hourly, daily, weekly, monthly'
        });
      }

      // Build aggregation pipeline
      const pipeline = [
        {
          $match: {
            'lastStatusChange.to': 'public',
            'lastStatusChange.changedAt': {
              $gte: parsedStartDate,
              $lte: parsedEndDate
            }
          }
        },
        {
          $group: {
            _id: interval === 'hourly'
              ? { $dateToString: { format: '%Y-%m-%dT%H:00:00.000Z', date: '$lastStatusChange.changedAt' } }
              : interval === 'daily'
                ? { $dateToString: { format: '%Y-%m-%d', date: '$lastStatusChange.changedAt' } }
                : interval === 'weekly'
                  ? { $dateToString: { format: '%Y-%U', date: '$lastStatusChange.changedAt' } }
                  : { $dateToString: { format: '%Y-%m', date: '$lastStatusChange.changedAt' } },
            count: { $sum: 1 }
          }
        },
        {
          $sort: { _id: 1 }
        }
      ];

      const results = await db.collection(MONGODB_COLLECTION_NAME)
        .aggregate(pipeline)
        .toArray();

      // Transform results for chart compatibility
      const data = results.map(item => ({
        date: item._id,
        value: item.count
      }));

      logEvent('http', 'Sending opportunity growth statistics', { 
        dataPoints: data.length,
        interval,
        dateRange: {
          start: parsedStartDate.toISOString(),
          end: parsedEndDate.toISOString()
        }
      });

      res.json({
        data,
        metadata: {
          interval,
          startDate: parsedStartDate.toISOString(),
          endDate: parsedEndDate.toISOString(),
          totalOpportunities: data.reduce((sum, item) => sum + item.value, 0)
        }
      });
    } catch (error) {
      logEvent('error', 'Error fetching opportunity growth statistics', { 
        error: error.message,
        stack: error.stack 
      });
      res.status(500).json({ 
        error: 'Internal server error',
        details: 'Error fetching opportunity growth statistics'
      });
    }
  });

  app.patch('/opportunities/:id/status', validateToken, async (req, res) => {
    const opportunityId = req.params.id; // Store ID at the top level
    let currentStatus, newStatus; // Declare variables at the top level
    
    try {
      newStatus = req.body.status?.toLowerCase();
      const userId = req.user.id; // Get user ID from the validated token
      
      logEvent('http', 'Attempting to update opportunity status', { 
        opportunityId,
        newStatus,
        userId 
      });

      // Validate status value
      const VALID_STATUSES = ['in review', 'public', 'private', 'rejected'];
      if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
        logEvent('http', 'Invalid status value provided', { newStatus });
        return res.status(400).json({ 
          error: 'Invalid status. Allowed values: in review, public, private, rejected' 
        });
      }

      // Get current opportunity
      const opportunity = await db.collection(MONGODB_COLLECTION_NAME)
        .findOne({ _id: new ObjectId(opportunityId) });

      if (!opportunity) {
        logEvent('http', 'Opportunity not found', { opportunityId });
        return res.status(404).json({ error: 'Opportunity not found' });
      }

      currentStatus = opportunity.status?.toLowerCase();
      
      // Validate status transitions
      const isValidTransition = (() => {
        switch (currentStatus) {
          case 'in review':
            return ['public', 'rejected'].includes(newStatus);
          case 'public':
            return newStatus === 'private';
          case 'private':
            // Allow transition to public only if the user made the private transition
            if (newStatus === 'public') {
              const lastPrivateTransition = opportunity.statusHistory
                ?.reverse()
                ?.find(change => change.to === 'private');
              
              logEvent('status', 'Checking private to public transition permission', {
                userId,
                lastPrivateTransition,
                hasPermission: lastPrivateTransition?.changedBy === userId
              });

              return lastPrivateTransition?.changedBy === userId;
            }
            return false;
          case 'rejected':
            return newStatus === 'in review';
          default:
            return false;
        }
      })();

      if (!isValidTransition) {
        logEvent('http', 'Invalid status transition', { 
          currentStatus,
          newStatus,
          userId
        });

        // Customize error message for private to public transition
        if (currentStatus === 'private' && newStatus === 'public') {
          return res.status(403).json({ 
            error: 'Only the user who made the private transition can make it public again',
            currentStatus,
            requestedStatus: newStatus,
            allowedTransitions: {
              'in review': ['public', 'rejected'],
              'public': ['private'],
              'private': ['public (only by same user)'],
              'rejected': ['in review']
            }
          });
        }

        return res.status(400).json({ 
          error: `Cannot change status from '${currentStatus}' to '${newStatus}'`,
          allowedTransitions: {
            'in review': ['public', 'rejected'],
            'public': ['private'],
            'private': ['public (only by same user)'],
            'rejected': ['in review']
          }
        });
      }

      // Create status change history entry
      const statusChange = {
        from: currentStatus,
        to: newStatus,
        changedBy: userId,
        changedAt: new Date(),
      };

      logEvent('mongodb', 'Attempting status update in MongoDB', {
        opportunityId,
        statusChange,
        update: {
          status: newStatus,
          lastStatusChange: statusChange
        }
      });

      // Update the status and add to history
      const result = await db.collection(MONGODB_COLLECTION_NAME)
        .updateOne(
          { _id: new ObjectId(opportunityId) },
          { 
            $set: { 
              status: newStatus,
              lastStatusChange: statusChange
            },
            $push: { 
              statusHistory: statusChange
            }
          }
        );

      logEvent('mongodb', 'Status update result from MongoDB', {
        opportunityId,
        modifiedCount: result.modifiedCount,
        matchedCount: result.matchedCount,
        acknowledged: result.acknowledged
      });

      if (result.modifiedCount === 0) {
        logEvent('http', 'No changes made to opportunity', { opportunityId });
        return res.status(304).end();
      }

      // If status changed to public, publish to public-opportunities queue
      if (newStatus === 'public') {
        try {
          logEvent('status', 'Starting public status update process', {
            opportunityId,
            previousStatus: currentStatus,
            newStatus: newStatus,
            userId
          });

          const opportunityDetails = await db.collection(MONGODB_COLLECTION_NAME)
            .findOne({ _id: new ObjectId(opportunityId) });
          
          logEvent('status', 'Retrieved updated opportunity details', {
            opportunityId,
            hasData: !!opportunityDetails,
            currentStatus: opportunityDetails?.status,
            lastChange: opportunityDetails?.lastStatusChange
          });
            
          const queueMessage = {
            eventType: 'opportunity_public',
            opportunity: {
              id: opportunityDetails._id.toString(),
              data: opportunityDetails.data,
              status: opportunityDetails.status,
              lastStatusChange: statusChange,
              metadata: {
                publishedAt: new Date().toISOString(),
                previousStatus: currentStatus
              }
            }
          };

          logEvent('status', 'Prepared queue message', {
            opportunityId,
            messageSize: Buffer.byteLength(JSON.stringify(queueMessage)),
            messageContent: {
              eventType: queueMessage.eventType,
              opportunityId: queueMessage.opportunity.id,
              status: queueMessage.opportunity.status,
              metadata: queueMessage.opportunity.metadata
            }
          });

          logEvent('rabbitmq', 'Publishing to public-opportunities queue', {
            opportunityId,
            eventType: 'opportunity_public',
            queueName: 'public-opportunities',
            messageSize: Buffer.byteLength(JSON.stringify(queueMessage)),
            channelStatus: {
              isOpen: channel && !channel.closing,
              connection: connection ? 'connected' : 'disconnected'
            }
          });

          // Verify channel and connection before publishing
          if (!channel || channel.closing) {
            logEvent('rabbitmq', 'Channel validation failed', {
              opportunityId,
              channelExists: !!channel,
              channelClosing: channel?.closing
            });
            throw new Error('RabbitMQ channel is not available');
          }

          // Check if the channel is still open and connection is valid
          if (!connection || connection.connection.stream.destroyed) {
            logEvent('rabbitmq', 'Connection validation failed', {
              opportunityId,
              connectionExists: !!connection,
              streamDestroyed: connection?.connection?.stream?.destroyed
            });
            throw new Error('RabbitMQ connection is closed or invalid');
          }

          // Attempt to publish with additional error handling
          const publishResult = channel.publish(
            '',  // default exchange
            'public-opportunities',
            Buffer.from(JSON.stringify(queueMessage)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: `${opportunityId}_${Date.now()}`
            }
          );

          // Check if publish was successful
          if (publishResult === false) {
            logEvent('rabbitmq', 'Publish operation returned false', {
              opportunityId,
              channelState: {
                isOpen: channel && !channel.closing,
                connection: connection ? 'connected' : 'disconnected'
              }
            });
            throw new Error('Channel publish returned false');
          }

          logEvent('rabbitmq', 'Successfully published to public-opportunities queue', {
            opportunityId,
            messageId: `${opportunityId}_${Date.now()}`
          });
        } catch (publishError) {
          logEvent('error', 'Comprehensive RabbitMQ publish failure', {
            error: publishError.message,
            stack: publishError.stack,
            opportunityId,
            channelStatus: {
              exists: !!channel,
              isOpen: channel && !channel.closing,
              connection: connection ? 'connected' : 'disconnected'
            },
            connectionDetails: {
              url: RABBITMQ_URL,
              isConnected: !!connection,
              connectionState: connection ? connection.connection.stream.readyState : 'no connection',
              connectionError: connection?.connection?.err?.message
            },
            systemInfo: {
              platform: process.platform,
              nodeVersion: process.version,
              env: process.env.NODE_ENV || 'development',
              memory: process.memoryUsage()
            }
          });
          
          throw new Error(`Failed to publish to queue: ${publishError.message}`);
        }
      }

      logEvent('http', 'Successfully updated opportunity status', { 
        opportunityId,
        statusChange
      });

      res.json({ 
        message: 'Status updated successfully',
        statusChange: {
          previousStatus: currentStatus,
          newStatus: newStatus,
          changedBy: userId,
          changedAt: statusChange.changedAt
        }
      });
    } catch (error) {
      if (error.message.includes('ObjectId')) {
        logEvent('http', 'Invalid ID format', { opportunityId });
        return res.status(400).json({ error: 'Invalid ID format' });
      }
      
      // Get channel and connection status safely
      const channelStatus = {
        exists: !!channel,
        isOpen: channel && !channel.closing,
        connection: connection ? 'connected' : 'disconnected'
      };
      
      logEvent('error', 'Error updating opportunity status', { 
        error: error.message,
        stack: error.stack,
        opportunityId,
        requestBody: req.body,
        currentStatus: currentStatus || 'unknown',
        newStatus: newStatus || 'unknown',
        userId: req.user?.id,
        isRabbitMQError: error.message.includes('RabbitMQ') || error.message.includes('queue'),
        channelStatus
      });
      res.status(500).json({ 
        error: 'Internal server error',
        details: error.message
      });
    }
  });

  // Error handling middleware
  app.use((err, req, res, next) => {
    logEvent('error', 'Unhandled error', { 
      error: err.message,
      stack: err.stack 
    });
    res.status(500).json({ error: 'Internal server error' });
  });

  // Handle graceful shutdown
  const gracefulShutdown = async () => {
    logEvent('shutdown', 'Received shutdown signal');
    // Wait for existing requests to complete (adjust timeout as needed)
    server.close(() => {
      logEvent('shutdown', 'HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  // Start HTTP server
  const server = app.listen(PORT, '0.0.0.0', () => {
    logEvent('startup', 'HTTP server is running', { 
      port: PORT,
      environment: process.env.NODE_ENV || 'development'
    });
  });
}

async function start() {
  let connection, channel, db;

  try {
    logEvent('startup', 'Service starting up');
    
    // Connect to MongoDB
    logEvent('mongodb', 'Attempting to connect to MongoDB', { url: MONGODB_URL, database: MONGODB_DB_NAME });
    const client = new MongoClient(MONGODB_URL);
    await client.connect();
    db = client.db(MONGODB_DB_NAME);
    logEvent('mongodb', 'Successfully connected to MongoDB');

    // Connect to RabbitMQ
    logEvent('rabbitmq', 'Attempting to connect to RabbitMQ', { url: RABBITMQ_URL });
    connection = await amqp.connect(RABBITMQ_URL);
    channel = await connection.createChannel();
    logEvent('rabbitmq', 'Successfully connected to RabbitMQ');

    // Create indexes
    logEvent('mongodb', 'Creating indexes');
    await db.collection(MONGODB_COLLECTION_NAME).createIndex(
      { 'statusHistory.changedBy': 1 },
      { 
        name: 'statusHistory_changedBy',
        background: true
      }
    );
    
    // Add compound index for sorting
    await db.collection(MONGODB_COLLECTION_NAME).createIndex(
      { 
        'statusHistory.changedBy': 1,
        'lastStatusChange.changedAt': -1 
      },
      { 
        name: 'statusHistory_changedBy_lastChange',
        background: true
      }
    );
    logEvent('mongodb', 'Indexes created successfully');

    // Setup HTTP server with all necessary dependencies
    await setupHttpServer(db, channel, connection);

    // Ensure the queues exist
    logEvent('rabbitmq', 'Asserting queues existence');
    await channel.assertQueue('opportunity', { durable: true });
    await channel.assertQueue('public-opportunities', { durable: true });
    logEvent('rabbitmq', 'Queues assertion successful');

    // Consume messages
    channel.consume('opportunity', async (msg) => {
      if (msg !== null) {
        const messageId = msg.properties.messageId || 'unknown';
        logEvent('message', 'Received new message', { messageId });
        
        try {
          const content = JSON.parse(msg.content.toString());
          logEvent('message', 'Successfully parsed message content', { 
            messageId,
            eventType: content.eventType,
            fullContent: content
          });

          // Extract the opportunity data
          const opportunityData = content.data;
          logEvent('processing', 'Extracted opportunity data', { 
            messageId,
            opportunityId: opportunityData.id || 'unknown',
            hasStatus: 'status' in opportunityData,
            currentStatus: opportunityData.status,
            dataKeys: Object.keys(opportunityData),
            fullData: opportunityData
          });

          // Add status field
          const originalStatus = opportunityData.status;
          opportunityData.status = 'in review';
          logEvent('processing', 'Added status field to opportunity data', {
            messageId,
            originalStatus,
            newStatus: opportunityData.status,
            hasStatusAfterSet: 'status' in opportunityData,
            finalDataKeys: Object.keys(opportunityData),
            finalData: opportunityData
          });

          // Add metadata
          opportunityData.metadata = {
            submittedAt: new Date().toISOString(),
            source: 'rabbitmq',
            environment: 'railway',
            messageId
          };

          // Store in MongoDB
          logEvent('mongodb', 'Attempting to store data', { 
            messageId,
            dataToStore: opportunityData,
            hasStatus: 'status' in opportunityData,
            status: opportunityData.status
          });
          const result = await db.collection(MONGODB_COLLECTION_NAME).insertOne(opportunityData);
          logEvent('mongodb', 'Successfully stored data', { 
            messageId,
            mongoId: result.insertedId.toString() 
          });

          // Acknowledge the message
          channel.ack(msg);
          logEvent('message', 'Message acknowledged', { messageId });
        } catch (error) {
          logEvent('error', 'Error processing message', { 
            messageId,
            error: error.message,
            stack: error.stack 
          });
          // Nack the message and requeue it
          channel.nack(msg, false, true);
          logEvent('message', 'Message nacked and requeued', { messageId });
        }
      }
    });

    logEvent('startup', 'Service ready and waiting for messages');
  } catch (error) {
    logEvent('error', 'Fatal error occurred', { 
      error: error.message,
      stack: error.stack 
    });
    
    // Attempt to close connections if they were established
    if (channel) {
      logEvent('shutdown', 'Closing RabbitMQ channel');
      await channel.close();
    }
    if (connection) {
      logEvent('shutdown', 'Closing RabbitMQ connection');
      await connection.close();
    }
    if (db) {
      logEvent('shutdown', 'Closing MongoDB connection');
      await db.client.close();
    }
    process.exit(1);
  }
}

start();

