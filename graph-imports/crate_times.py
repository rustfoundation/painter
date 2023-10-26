import psycopg2
from neo4j import GraphDatabase

#establishing the connection
conn = psycopg2.connect(
   database="crates", user='jaynus', password='asdf', host='172.17.0.2', port= '5432'
)

graphdb = GraphDatabase.driver('bolt://127.0.0.1:7687', auth=('neo4j', 'changeme123'))

cursor = conn.cursor()
cursor.execute('''SELECT crates.name,crates.created_at  FROM crates''')
for row in cursor:
  records, _, _ = graphdb.execute_query(
          "MATCH (c:Crate { name: $name }) SET c.created_at = datetime($created_at) RETURN count(c)",
          name=row[0], created_at=row[1], database_="neo4j",
      )
  for record in records:
          print(record)
conn.close()