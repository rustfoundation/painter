import psycopg2
from neo4j import GraphDatabase

#establishing the connection
conn = psycopg2.connect(
   database="crates", user='jaynus', password='asdf', host='172.17.0.2', port= '5432'
)

graphdb = GraphDatabase.driver('bolt://127.0.0.1:7687', auth=('neo4j', 'changeme123'))

cursor = conn.cursor()
cursor.execute('''SELECT crates.name, versions.num, versions.created_at FROM versions JOIN crates ON versions.crate_id = crates.id''')
for row in cursor:
  records, _, _ = graphdb.execute_query(
          "MATCH (v:Version { name: $name, version: $version}) SET v.created_at = datetime($created_at) RETURN count(v)",
          name=row[0], version=row[1], created_at=row[2], database_="neo4j",
      )
  for record in records:
          print(record)


conn.close()